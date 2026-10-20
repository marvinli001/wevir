// 录制测试样本（src/test-fixtures/sdk/）：用本机真实的 `claude`（用户自己的登录，会用掉一点订阅额度）跑几个最小的场景，
// 把 Claude Agent SDK 交出来的消息原样存下，本机路径换成占位符。平时跳过；升级 SDK 或 `claude` 后重录：
//
//   env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_RECORD_CLAUDE=1 pnpm vitest run --project adapter-claude record-sdk
//
// （`env -i`：Host 由 Claude Code 拉起时的那些环境变量不要带进来，见 env.ts。）录制不读用户的设置（`settingSources: []`，
// 不跑 hooks、不连 MCP、不读 CLAUDE.md），模型用最便宜的 claude-haiku-4-5。每个文件第一行是 `{"_meta": …}`，其余每行
// 是 `{"prompt": 文本}`（推给 SDK 的消息）、`{"message": SDKMessage}`（SDK 交出的消息）或 `{"permission": {…}}`
// （`canUseTool` 被调用的位置与当时的决定）。映射测试（claude-adapter.test.ts）与假的 SDK（fake-sdk.ts）用它们。

import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeEnv } from '../env.js';
import { findClaude, probeClaudeVersion } from '../executable.js';
import {
  type PermissionResult,
  realClaudeSdk,
  type SDKMessage,
  type SDKUserMessage,
} from '../sdk.js';

const RECORD = process.env.WEVIR_RECORD_CLAUDE === '1';
const OUT_DIR = join(import.meta.dirname, 'sdk');
const MODEL = 'claude-haiku-4-5';

type Decision = 'allow' | 'decline' | 'interrupt';

interface Scenario {
  name: string;
  description: string;
  prompt: string;
  files?: Record<string, string>;
  decision?: Decision;
  /** 回合开始输出文本之后插话（`priority`）。 */
  steer?: { text: string; priority: 'now' | 'next' };
}

const WRITE_PROMPT =
  'Use the Write tool to create a file named approve.txt containing the text ok. Then reply with the single word done.';

const SCENARIOS: Scenario[] = [
  {
    name: 'plain',
    description: '一问一答：思考与文本的增量 → 快照 → 结果',
    prompt: 'Reply with exactly the word hello.',
  },
  {
    name: 'tool',
    description: '不需要审批的工具调用：Read 工作区里的文件 → 工具结果 → 回答',
    prompt: 'Use the Read tool to read the file hello.txt, then reply with its contents.',
    files: { 'hello.txt': 'wevir fixture\n' },
  },
  {
    name: 'approval.allow',
    description: '审批：Write 经 canUseTool 问用户，允许 → 工具完成 → 回答',
    prompt: WRITE_PROMPT,
    decision: 'allow',
  },
  {
    name: 'approval.decline',
    description: '审批：拒绝并继续 → 工具结果是错误 → 模型接着回答',
    prompt: WRITE_PROMPT,
    decision: 'decline',
  },
  {
    name: 'approval.interrupt',
    description: '审批挂起时中断（Query.interrupt）→ 中断的结果',
    prompt: WRITE_PROMPT,
    decision: 'interrupt',
  },
  {
    name: 'subagent',
    description: '子 agent：Agent 工具 → 子 agent 的消息（parent_tool_use_id）→ 工具结果 → 回答',
    prompt:
      'Use the Agent tool with subagent_type general-purpose to have a subagent reply with exactly the word pong. Then tell me in one word what it said.',
  },
  {
    name: 'steer.next',
    description: '插话（priority next）：文本输出途中推一条用户消息',
    prompt: 'Write the numbers from 1 to 60 in words, one per line, with no other text.',
    steer: { text: 'Also add one final line that says weather.', priority: 'next' },
  },
  {
    name: 'steer.now',
    description: '插话（priority now，T3 的做法）：文本输出途中推一条用户消息',
    prompt: 'Write the numbers from 1 to 60 in words, one per line, with no other text.',
    steer: { text: 'Also add one final line that says weather.', priority: 'now' },
  },
];

/** 本机路径换成 `<cwd>` / `<tmp>`；初始化消息里用户环境的清单清空（公开仓库）。 */
function sanitize(value: unknown, cwd: string): unknown {
  const json = JSON.stringify(value)
    .replaceAll(cwd, '<cwd>')
    .replaceAll(cwd.replaceAll(/[/.]/g, '-'), '<cwd-key>')
    .replaceAll(realpathSync(tmpdir()), '<tmp>')
    .replaceAll(/<tmp>\/claude-\d+\//g, '<tmp>/claude-<uid>/');
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    for (const key of [
      'mcp_servers',
      'slash_commands',
      'skills',
      'plugins',
      'agents',
      'plugin_errors',
    ]) {
      if (key in parsed) parsed[key] = [];
    }
    if ('memory_paths' in parsed) parsed.memory_paths = {};
  }
  return parsed;
}

describe.skipIf(!RECORD)('录制 Claude Agent SDK 的消息', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, { timeout: 180_000 }, async () => {
      const executable = findClaude();
      if (executable === undefined) throw new Error('claude is not installed');
      const env = claudeEnv(process.env, executable);
      const version = await probeClaudeVersion(executable, env);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-claude-record-')));
      for (const [name, content] of Object.entries(scenario.files ?? {})) {
        writeFileSync(join(cwd, name), content);
      }
      const lines: unknown[] = [
        {
          _meta: {
            scenario: scenario.name,
            description: scenario.description,
            claudeVersion: version.ok ? version.version : undefined,
            model: MODEL,
          },
        },
      ];
      let closeInput: () => void = () => {};
      let pushSteer: (() => void) | undefined;
      let steerUuid = '';
      const steerReady = new Promise<void>((resolve) => {
        pushSteer = resolve;
      });
      const input: AsyncIterable<SDKUserMessage> = {
        async *[Symbol.asyncIterator]() {
          const uuid = randomUUID();
          lines.push({ prompt: scenario.prompt, uuid });
          yield {
            type: 'user',
            message: { role: 'user', content: scenario.prompt },
            parent_tool_use_id: null,
            uuid: uuid as SDKUserMessage['uuid'],
          };
          if (scenario.steer !== undefined) {
            await steerReady;
            steerUuid = randomUUID();
            lines.push({
              prompt: scenario.steer.text,
              uuid: steerUuid,
              priority: scenario.steer.priority,
            });
            yield {
              type: 'user',
              message: { role: 'user', content: scenario.steer.text },
              parent_tool_use_id: null,
              priority: scenario.steer.priority,
              uuid: steerUuid as SDKUserMessage['uuid'],
            };
          }
          await new Promise<void>((resolve) => {
            closeInput = resolve;
          });
        },
      };
      let interrupt: () => void = () => {};
      await realClaudeSdk.load?.();
      const q = realClaudeSdk.query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: executable,
          env,
          cwd,
          model: MODEL,
          permissionMode: 'default',
          settingSources: [],
          includePartialMessages: true,
          forwardSubagentText: true,
          thinking: { type: 'adaptive', display: 'summarized' },
          persistSession: false,
          canUseTool: async (toolName, toolInput, options): Promise<PermissionResult> => {
            const decision: Decision = scenario.decision ?? 'allow';
            lines.push({
              permission: {
                toolName,
                input: sanitize(toolInput, cwd),
                toolUseID: options.toolUseID,
                decision,
              },
            });
            if (decision === 'interrupt') {
              interrupt();
              return new Promise((resolve) => {
                options.signal.addEventListener('abort', () =>
                  resolve({ behavior: 'deny', message: 'interrupted', interrupt: true }),
                );
              });
            }
            return decision === 'allow'
              ? { behavior: 'allow', updatedInput: toolInput, toolUseID: options.toolUseID }
              : {
                  behavior: 'deny',
                  message: 'User declined tool execution.',
                  toolUseID: options.toolUseID,
                };
          },
          stderr: () => {},
        },
      });
      interrupt = () => {
        void q.interrupt();
      };
      let results = 0;
      try {
        for await (const message of {
          [Symbol.asyncIterator]: () => q,
        } as AsyncIterable<SDKMessage>) {
          // 命令清单里有用户装的插件与技能（公开仓库），映射也不用它。
          if (message.type === 'system' && message.subtype === 'commands_changed') continue;
          lines.push({ message: sanitize(message, cwd) });
          if (
            message.type === 'stream_event' &&
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta'
          ) {
            pushSteer?.();
            pushSteer = undefined;
          }
          // 插话的场景要等插话那一轮也结束：结果带上插话的 uuid，或者已经是第二个结果。
          if (message.type === 'result') {
            results += 1;
            const echoed = message.user_message_uuids ?? [];
            if (scenario.steer === undefined || echoed.includes(steerUuid) || results >= 2) break;
          }
        }
      } finally {
        closeInput();
        q.close();
        rmSync(cwd, { recursive: true, force: true });
        // 不写会话记录时 claude 仍为子 agent 在 ~/.claude/projects 下建以工作目录命名的文件夹；只删这个临时目录的那一个。
        const key = cwd.replaceAll(/[/.]/g, '-');
        if (key.includes('wevir-claude-record-')) {
          rmSync(join(homedir(), '.claude', 'projects', key), { recursive: true, force: true });
        }
      }
      writeFileSync(
        join(OUT_DIR, `${scenario.name}.jsonl`),
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      );
      expect(lines.some((line) => 'message' in (line as object))).toBe(true);
    });
  }
});
