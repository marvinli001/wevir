// 用户的说明与输出风格（0.78.0，domain-model §3.34）：用户在设置里写的“给 Agent 的说明”加上选的输出风格，由 Host 拼成一段交给会话
// 的引擎。它和补给的规则文件放在一起、走同一个通道（规则文件的 `channel`）：引擎有说明可放时进它的系统或开发者说明，没有时放在下一条
// 消息的开头；`session.rules` 的 `custom` 记下交了哪些。
//
// 拼法：prompts/user-instructions.md 的开头，说明（去掉首尾空白后空的不放）包在 `<user_instructions>` 里，然后是
// prompts/output-styles/<风格>.md 的正文。
//
// 说明对所有会话都给；风格只给用户直接对话的会话：Agent 开的、带预设角色的、第二意见与自动化开的会话不给（“边做边学”会停下等人写
// 代码，“主动”会少问，这些会话没有人在看）。
//
// 带 `reminder` 的风格（简洁、主动）在每条新回合的消息末尾附一行提醒（`<system-reminder>`），只进引擎、不进消息记录。
//
// 写作风格（0.95.0，domain-model §3.43）：设置开着时接在最后。有档案时是 prompts/writing-style/apply.md 加包在
// `<writing_style_profile>` 里的档案，没有时是 none.md（用户要时再建档）。和说明一样对所有会话都给：替用户起草的也可能是子会话。
//
// 编码纪律（domain-model §3.34）：prompts/coding-discipline.md，Wevir 自带的写代码做法，放在最前面、在用户的开头说明之外（它是
// 默认做法，不是用户写的，项目说明文件与用户的说明都盖得过它）。对所有会话都给，不看设置；引擎自己带着这套做法时不给（适配器的
// `EngineRuleFiles.codingGuidance`，Claude Code）。只有它时 `custom` 是 `{ instructions: false, bytes }`，桌面端没有行可列。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type HostSettings,
  isOutputStyle,
  OUTPUT_STYLES,
  type SessionCustomInstructions,
} from '@wevir/protocol';
import type { SessionRecord } from '@wevir/storage';
import { defaultPromptsDir } from './title.js';

/** 一种输出风格：正文与每回合提醒（有的话）。 */
export interface StylePrompt {
  body: string;
  reminder?: string;
}

export interface CustomPrompts {
  header: string;
  /** 编码纪律：prompts/coding-discipline.md 的正文。 */
  codingDiscipline: string;
  outputStyles: ReadonlyMap<string, StylePrompt>;
  /** 写作风格（0.95.0）：有档案时的用法、没有档案时的提示、建档步骤（工具返回）。 */
  writingStyle: { apply: string; none: string; setup: string };
}

/**
 * 读 prompts/user-instructions.md、coding-discipline.md、output-styles/ 下 Host 认识的那几份与 writing-style/ 的三份。按 prompts/README.md 的模板语法删掉 HTML 注释；开头的
 * `---` 块里只认 `reminder: …` 一行。缺文件或残留 `{{` 就报错。
 */
export function loadCustomPrompts(dir: string = defaultPromptsDir()): CustomPrompts {
  const read = (path: string) => parsePrompt(readFileSync(join(dir, path), 'utf8'), path);
  return {
    header: read('user-instructions.md').body,
    codingDiscipline: read('coding-discipline.md').body,
    outputStyles: new Map(
      OUTPUT_STYLES.map((name) => [name, read(join('output-styles', `${name}.md`))]),
    ),
    writingStyle: {
      apply: read(join('writing-style', 'apply.md')).body,
      none: read(join('writing-style', 'none.md')).body,
      setup: read(join('writing-style', 'setup.md')).body,
    },
  };
}

export function parsePrompt(source: string, path: string): StylePrompt {
  let text = source;
  let reminder: string | undefined;
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (front !== null) {
    text = text.slice(front[0].length);
    for (const line of (front[1] ?? '').split('\n')) {
      const match = /^reminder:\s*(.+)$/.exec(line.trim());
      if (match?.[1] !== undefined) reminder = match[1].trim();
    }
  }
  const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (body.includes('{{') || reminder?.includes('{{')) {
    throw new Error(`${path} 里残留了 {{（prompts/README.md 模板语法）`);
  }
  return reminder === undefined ? { body } : { body, reminder };
}

/** 一个会话要的说明与风格。 */
export interface CustomInputs {
  instructions?: string;
  outputStyle?: string;
  /** 设置开着时有；`profile` 是档案正文，还没有档案时省略。 */
  writingStyle?: { profile?: string };
  /** 引擎没有自带写代码的做法，要补 Wevir 的编码纪律。 */
  codingDiscipline?: true;
}

/**
 * 按设置算出这个会话的输入。`styled` 为 false（不是用户直接对话的会话）时不带风格。不认识的风格（旧设置文件里手改的）当作
 * `default`。`codingDiscipline`：引擎没有自带写代码的做法，不看设置，直接带上编码纪律。
 */
export function customInputs(
  settings: Pick<HostSettings, 'agentInstructions' | 'outputStyle'>,
  styled: boolean,
  codingDiscipline = false,
): CustomInputs {
  const inputs: CustomInputs = {};
  const instructions = settings.agentInstructions;
  if (instructions !== undefined && instructions.trim() !== '') inputs.instructions = instructions;
  const style = settings.outputStyle;
  if (styled && style !== undefined && style !== 'default' && isOutputStyle(style)) {
    inputs.outputStyle = style;
  }
  if (codingDiscipline) inputs.codingDiscipline = true;
  return inputs;
}

/** 写作风格的输入（0.95.0）：设置关着时 `undefined`。 */
export function writingStyleInput(
  settings: Pick<HostSettings, 'writingStyle'>,
  profile: string | undefined,
): CustomInputs['writingStyle'] {
  if (settings.writingStyle !== true) return undefined;
  return profile === undefined ? {} : { profile };
}

/** 交给引擎的那一段与 `session.rules` 的 `custom`；什么都没有时 `undefined`。 */
export interface CustomPlan {
  custom: SessionCustomInstructions;
  text: string;
}

export function planCustom(prompts: CustomPrompts, inputs: CustomInputs): CustomPlan | undefined {
  const style =
    inputs.outputStyle === undefined ? undefined : prompts.outputStyles.get(inputs.outputStyle);
  const blocks: string[] = [];
  if (inputs.instructions !== undefined) {
    blocks.push(`<user_instructions>\n${inputs.instructions.trim()}\n</user_instructions>`);
  }
  if (style !== undefined) blocks.push(style.body);
  const writing = inputs.writingStyle;
  if (writing !== undefined) {
    blocks.push(
      writing.profile === undefined
        ? prompts.writingStyle.none
        : `${prompts.writingStyle.apply}\n\n<writing_style_profile>\n${writing.profile.trim()}\n</writing_style_profile>`,
    );
  }
  const discipline = inputs.codingDiscipline === true;
  if (blocks.length === 0 && !discipline) return undefined;
  // 编码纪律在最前面、不在“用户的说明”开头之下：它不是用户写的，项目说明文件与用户的说明都盖得过它。
  const text = [
    ...(discipline ? [prompts.codingDiscipline] : []),
    ...(blocks.length > 0 ? [prompts.header, ...blocks] : []),
  ].join('\n\n');
  return {
    custom: {
      instructions: inputs.instructions !== undefined,
      ...(style !== undefined && { outputStyle: inputs.outputStyle }),
      ...(writing !== undefined && {
        writingStyle: writing.profile === undefined ? 'setup' : 'profile',
      }),
      bytes: Buffer.byteLength(text),
    },
    text,
  };
}

/** 风格的每回合提醒，包成 `<system-reminder>` 接在消息末尾；这个风格没有提醒时 `undefined`。 */
export function styleReminder(prompts: CustomPrompts, outputStyle: string | undefined) {
  const reminder =
    outputStyle === undefined ? undefined : prompts.outputStyles.get(outputStyle)?.reminder;
  return reminder === undefined ? undefined : `<system-reminder>\n${reminder}\n</system-reminder>`;
}

/**
 * 会话是不是用户直接对话的（给不给风格）：子会话、Agent 开的、带预设角色的、第二意见与自动化开的都不是；从建议开的、不带角色的
 * 分支与支线是。
 */
export function styledSession(record: Pick<SessionRecord, 'origin' | 'parentSessionId'>): boolean {
  if (record.parentSessionId !== undefined) return false;
  const origin = record.origin;
  if (origin === undefined) return true;
  // 频道的协调者与线程（0.120.0）直接对用户说话。
  if (origin.kind === 'channel') return true;
  return (origin.kind === 'suggested_task' || origin.kind === 'fork') && origin.role === undefined;
}
