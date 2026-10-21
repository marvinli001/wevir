// 调优的建议（0.87.0）：组模型的输入、解析模型的输出。发请求的是 SessionManager.generateOnce（适配器的 `generateTitle`，会话
// 当前的模型），见 proposals.ts。
//
// 输入是几段 XML 样的文本：回顾摘要、回顾骨架（retro/summary.ts 的 `retroSummaryInput`，每行带 ID）、护栏命中、项目现在的配置
// （规则文件全文、技能清单、记忆索引、护栏）、本项目拒绝过的建议、这次允许的种类。输出是严格的 JSON；每条建议按种类校验，不合格
// 的丢掉（记警告），一条都解析不出、或根本不是那个形状才算解析失败。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type GuardrailBlocked,
  type GuardrailRule,
  GuardrailRuleSchema,
  MEMORY_DESCRIPTION_MAX,
  MemoryTypeSchema,
  type RetroRef,
  type SessionRetro,
  type Skill,
  TUNING_PROPOSAL_EVIDENCE_MAX,
  TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH,
  TUNING_PROPOSAL_TITLE_MAX_LENGTH,
  TUNING_PROPOSALS_MAX,
  type TuningProposalEvidence,
  type TuningProposalKind,
} from '@wevir/protocol';
import { clipText } from '../retro/fold.js';
import { defaultPromptsDir } from '../title.js';

/** 规则文件全文的总上限（UTF-8 字节）；超了后面的文件只列名字。项目的 `AGENTS.md` 总排在最前。 */
export const PROPOSAL_RULES_MAX_BYTES = 24_000;
/** 技能清单、护栏、拒绝过的建议各自的上限（条）。 */
const SKILLS_MAX = 60;
const GUARDRAILS_MAX = 50;
const REJECTED_MAX = 20;
const GUARDRAIL_HITS_MAX = 30;
/** 等模型写建议的时限。 */
export const PROPOSAL_TIMEOUT_MS = 120_000;

export const PROPOSAL_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      maxItems: TUNING_PROPOSALS_MAX,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['rule', 'skill', 'memory', 'guardrail'] },
          title: { type: 'string' },
          target: { type: 'string' },
          description: { type: 'string' },
          memoryType: { type: 'string' },
          body: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['kind', 'title', 'target', 'description', 'memoryType', 'body', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
});

/** 读 `tuning-proposals.md` 作为说明（同 `loadRetroInstructions`）。 */
export function loadProposalInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'tuning-proposals.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('tuning-proposals.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export interface ProposalRuleFile {
  /** 显示的路径（相对项目根，或 `~/…`）。 */
  label: string;
  text: string;
  /** 项目根的 `AGENTS.md`：唯一能改的那一份。 */
  editable?: boolean;
}

export interface ProposalInput {
  summary?: SessionRetro['summary'];
  /** `retroSummaryInput` 组好的骨架（已脱敏）。 */
  retro: string;
  guardrailHits: readonly { seq: number; blocked: GuardrailBlocked }[];
  ruleFiles: readonly ProposalRuleFile[];
  /** 项目根的 `AGENTS.md` 不存在。 */
  agentsMissing: boolean;
  skills: readonly Pick<Skill, 'name' | 'description' | 'source'>[];
  memoryIndex?: string;
  guardrails: readonly { rule: GuardrailRule; name?: string; scope: 'global' | 'project' }[];
  rejected: readonly { kind: string; title: string; target: string }[];
  allowed: readonly TuningProposalKind[];
}

/** 护栏规则写成一行。 */
export function guardrailLine(rule: GuardrailRule): string {
  switch (rule.kind) {
    case 'forbidden_command':
      return `forbidden_command (${rule.match}): ${rule.pattern}`;
    case 'protected_path':
      return `protected_path: ${rule.glob}`;
    case 'stop_check':
      return `stop_check: ${rule.command}`;
    case 'commit_check':
      return `commit_check: ${rule.command}`;
  }
}

/** 护栏命中的行 ID（`g<seq>`）。 */
export const guardrailHitId = (seq: number) => `g${seq}`;

export function proposalInput(input: ProposalInput): string {
  const parts: string[] = [];
  if (input.summary !== undefined) {
    parts.push(
      `<summary>\n${input.summary.points
        .map((point) => `- ${escapeXml(point.text)} [${point.refs.join(', ')}]`)
        .join('\n')}\n</summary>`,
    );
  }
  parts.push(input.retro);
  const hits = input.guardrailHits.slice(-GUARDRAIL_HITS_MAX);
  parts.push(
    `<guardrail_hits>\n${
      hits.length === 0
        ? 'none'
        : hits
            .map(
              ({ seq, blocked }) =>
                `[${guardrailHitId(seq)}] guardrail ${blocked.action} ${blocked.kind}: ${escapeXml(
                  clipText(blocked.command ?? blocked.path ?? '', 200),
                )}: ${escapeXml(clipText(blocked.reason, 300))}`,
            )
            .join('\n')
    }\n</guardrail_hits>`,
  );

  const project: string[] = [];
  let budget = PROPOSAL_RULES_MAX_BYTES;
  if (input.agentsMissing)
    project.push('<rule_file path="AGENTS.md" editable="true" missing="true"/>');
  for (const file of input.ruleFiles) {
    const size = Buffer.byteLength(file.text, 'utf8');
    const attrs = `path="${escapeXml(file.label)}"${file.editable === true ? ' editable="true"' : ''}`;
    if (size > budget && file.editable !== true) {
      project.push(`<rule_file ${attrs} omitted="too long"/>`);
      continue;
    }
    budget -= size;
    project.push(`<rule_file ${attrs}>\n${escapeXml(file.text)}\n</rule_file>`);
  }
  const skills = input.skills.slice(0, SKILLS_MAX);
  project.push(
    `<skills>\n${
      skills.length === 0
        ? 'none'
        : skills
            .map(
              (skill) =>
                `- ${escapeXml(skill.name)} (${skill.source}): ${escapeXml(clipText(skill.description, 200))}`,
            )
            .join('\n')
    }\n</skills>`,
  );
  project.push(`<memory>\n${escapeXml(input.memoryIndex ?? 'none')}\n</memory>`);
  const guardrails = input.guardrails.slice(0, GUARDRAILS_MAX);
  project.push(
    `<guardrails>\n${
      guardrails.length === 0
        ? 'none'
        : guardrails
            .map(
              (g) =>
                `- [${g.scope}] ${escapeXml(guardrailLine(g.rule))}${g.name ? ` (${escapeXml(g.name)})` : ''}`,
            )
            .join('\n')
    }\n</guardrails>`,
  );
  parts.push(`<project>\n${project.join('\n')}\n</project>`);

  const rejected = input.rejected.slice(0, REJECTED_MAX);
  parts.push(
    `<rejected>\n${
      rejected.length === 0
        ? 'none'
        : rejected
            .map((r) => `- ${r.kind} ${escapeXml(r.target)}: ${escapeXml(r.title)}`)
            .join('\n')
    }\n</rejected>`,
  );
  parts.push(`<allowed>${input.allowed.join(', ')}</allowed>`);
  return parts.join('\n\n');
}

/** 模型给的一条建议，按种类校验过（`rule` 的 `body` 还是 diff，由调用方打到原文上）。 */
export type ParsedProposal =
  | { kind: 'rule'; title: string; diff: string; evidence: string[] }
  | { kind: 'skill'; title: string; name: string; content: string; evidence: string[] }
  | {
      kind: 'memory';
      title: string;
      name: string;
      type: 'user' | 'feedback' | 'project' | 'reference';
      description: string;
      content: string;
      evidence: string[];
    }
  | { kind: 'guardrail'; title: string; name?: string; rule: GuardrailRule; evidence: string[] };

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * 解析模型的输出：第一个 `{` 到最后一个 `}` 之间的 JSON，`proposals` 是数组。每条按种类校验，不在 `allowed` 里或不合格的丢掉
 * （`dropped` 记原因）；`evidence` 只留 `knownIds` 里有的（去重，至多 `TUNING_PROPOSAL_EVIDENCE_MAX`）。根本不是这个形状时 undefined。
 */
export function parseProposals(
  output: string,
  options: { allowed: readonly TuningProposalKind[]; knownIds: ReadonlySet<string> },
): { proposals: ParsedProposal[]; dropped: string[] } | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const items = (value as Record<string, unknown>).proposals;
  if (!Array.isArray(items)) return undefined;
  const proposals: ParsedProposal[] = [];
  const dropped: string[] = [];
  for (const [index, item] of items.entries()) {
    if (proposals.length >= TUNING_PROPOSALS_MAX) {
      dropped.push(`${index}: over the limit`);
      continue;
    }
    const parsed = parseOne(item, options);
    if (typeof parsed === 'string') dropped.push(`${index}: ${parsed}`);
    else proposals.push(parsed);
  }
  return { proposals, dropped };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseOne(
  item: unknown,
  options: { allowed: readonly TuningProposalKind[]; knownIds: ReadonlySet<string> },
): ParsedProposal | string {
  if (typeof item !== 'object' || item === null) return 'not an object';
  const record = item as Record<string, unknown>;
  const kind = record.kind;
  if (!options.allowed.includes(kind as TuningProposalKind)) return `kind ${String(kind)}`;
  const title = clipText(str(record.title), TUNING_PROPOSAL_TITLE_MAX_LENGTH);
  if (title === '') return 'no title';
  const target = str(record.target).trim();
  const body = str(record.body);
  if (body.trim() === '') return 'no body';
  const evidence = Array.isArray(record.evidence)
    ? [
        ...new Set(
          record.evidence.filter(
            (id): id is string => typeof id === 'string' && options.knownIds.has(id),
          ),
        ),
      ].slice(0, TUNING_PROPOSAL_EVIDENCE_MAX)
    : [];
  switch (kind as TuningProposalKind) {
    case 'rule':
      return { kind: 'rule', title, diff: body, evidence };
    case 'skill':
      if (!NAME_PATTERN.test(target)) return `skill name ${target}`;
      return { kind: 'skill', title, name: target, content: body, evidence };
    case 'memory': {
      if (!NAME_PATTERN.test(target)) return `memory name ${target}`;
      const description = str(record.description).trim().split(/\s+/u).join(' ');
      if (description === '' || description.length > MEMORY_DESCRIPTION_MAX)
        return 'memory description';
      const type = MemoryTypeSchema.safeParse(str(record.memoryType).trim());
      return {
        kind: 'memory',
        title,
        name: target,
        type: type.success ? type.data : 'project',
        description,
        content: body.trim(),
        evidence,
      };
    }
    case 'guardrail': {
      let rule: unknown;
      try {
        rule = JSON.parse(body);
      } catch {
        return 'guardrail rule is not JSON';
      }
      const parsed = GuardrailRuleSchema.safeParse(rule);
      if (!parsed.success) return 'guardrail rule';
      if (parsed.data.kind === 'forbidden_command' && parsed.data.match === 'regex') {
        try {
          new RegExp(parsed.data.pattern);
        } catch {
          return 'guardrail regex';
        }
      }
      const name = clipText(target, 80);
      return {
        kind: 'guardrail',
        title,
        ...(name !== '' && { name }),
        rule: parsed.data,
        evidence,
      };
    }
  }
}

/** 一行证据在回顾里对应什么：文字、是第几个回合、跳转的出处。 */
export function evidenceIndex(
  retro: SessionRetro,
  hits: readonly { seq: number; blocked: GuardrailBlocked }[],
): Map<string, Omit<TuningProposalEvidence, 'id'>> {
  const map = new Map<string, Omit<TuningProposalEvidence, 'id'>>();
  const clip = (text: string) => clipText(text, TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH);
  const add = (id: string, text: string, ref?: RetroRef, turn?: number) => {
    if (map.has(id)) return;
    map.set(id, {
      text: clip(text),
      ...(turn !== undefined && { turn }),
      ...(ref !== undefined && { ref }),
    });
  };
  for (const [index, turn] of retro.turns.entries()) {
    add(turn.id, turn.text ?? '', { kind: 'event', seq: turn.seq, turnId: turn.turnId }, index + 1);
  }
  const items = [
    ...(retro.goal.goal ? [retro.goal.goal] : []),
    ...(retro.goal.request ? [retro.goal.request] : []),
    ...retro.done,
    ...retro.open,
    ...(retro.chapters ?? []),
    ...retro.verification.commands,
    ...retro.review.comments,
    ...retro.decisions,
    ...retro.next,
    ...retro.sessions,
    ...retro.memories,
  ];
  for (const item of items) add(item.id, item.text, item.ref);
  for (const check of retro.verification.checks) {
    add(check.id, `${check.name}: ${check.status}`, {
      kind: 'verification',
      runId: check.runId,
      seq: check.seq,
    });
  }
  for (const file of retro.changes.files) {
    const turnId = file.turnIds.at(-1);
    add(
      file.id,
      file.path,
      turnId === undefined ? undefined : { kind: 'turn_diff', turnId, path: file.path },
    );
  }
  for (const commit of retro.changes.commits) {
    add(commit.id, commit.subject, { kind: 'commit', sha: commit.sha });
  }
  for (const { seq, blocked } of hits) {
    add(
      guardrailHitId(seq),
      `${blocked.kind}: ${blocked.command ?? blocked.path ?? blocked.reason}`,
      {
        kind: 'event',
        seq,
        ...(blocked.turnId !== undefined && { turnId: blocked.turnId }),
      },
    );
  }
  return map;
}
