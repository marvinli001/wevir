// 任务回顾的可选模型摘要（0.76.0，ADR-0012 决策 9）：从骨架组输入（每行带 ID）、解析模型的输出、核对出处。发请求的是
// SessionManager.generateOnce（适配器的 `generateTitle`，会话当前的模型）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETRO_SUMMARY_MAX_POINTS,
  RETRO_SUMMARY_POINT_MAX_CHARS,
  type RetroSummaryPoint,
  type SessionRetro,
} from '@wevir/protocol';
import { defaultPromptsDir } from '../title.js';
import { clipText } from './fold.js';

/** 输入的总上限（UTF-8 字节）；超了从较早的回合、命令与决定开始丢。 */
export const RETRO_SUMMARY_INPUT_MAX_BYTES = 12_000;
/** 等模型写摘要的时限。 */
export const RETRO_SUMMARY_TIMEOUT_MS = 60_000;

export const RETRO_SUMMARY_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    points: {
      type: 'array',
      maxItems: RETRO_SUMMARY_MAX_POINTS,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1 },
          refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['text', 'refs'],
        additionalProperties: false,
      },
    },
  },
  required: ['points'],
  additionalProperties: false,
});

/** 读 `session-retro.md` 作为说明（同 `loadRecapInstructions`：去掉 HTML 注释与开头的空行，残留 `{{` 就报错）。 */
export function loadRetroInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'session-retro.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('session-retro.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function line(id: string, label: string, text: string): string {
  return `[${id}] ${label}: ${escapeXml(clipText(text, 300))}`;
}

/**
 * 组输入：骨架的每一行带 ID，模型只能引用这些 ID。固定部分（目标、完成与未完成、验证、交付状态、下一步）总是保留；回合、决定、
 * 命令按新到旧放，放不下就丢掉较早的。
 */
export function retroSummaryInput(retro: SessionRetro): string {
  const fixed: string[] = [];
  if (retro.goal.goal)
    fixed.push(line(retro.goal.goal.id, `goal (${retro.goal.goal.status})`, retro.goal.goal.text));
  if (retro.goal.request)
    fixed.push(line(retro.goal.request.id, 'first request', retro.goal.request.text));
  // 章节（0.82.0）是 Agent 自己标的阶段，给摘要当骨架；回合行带它所在的章节。
  for (const chapter of retro.chapters ?? [])
    fixed.push(
      line(
        chapter.id,
        `chapter (${chapter.turns} turns)`,
        chapter.summary ? `${chapter.text}: ${chapter.summary}` : chapter.text,
      ),
    );
  for (const item of retro.done)
    fixed.push(
      line(
        item.id,
        `done (${item.origin}, recorded status ${item.status}, not verification)`,
        item.text,
      ),
    );
  for (const item of retro.open)
    fixed.push(line(item.id, `open (${item.origin}, ${item.status})`, item.text));
  if (!retro.verification.recorded)
    fixed.push('[none] verification: no verification records (unverified)');
  for (const check of retro.verification.checks) {
    const evidence =
      check.evidence === undefined
        ? ''
        : `, ${check.evidence === 'current' ? 'matches current code' : check.evidence === 'outdated' ? 'result is for an older version of the code' : 'not bound to a code version'}`;
    fixed.push(
      line(
        check.id,
        `check ${check.name}`,
        `${check.status}${check.reason ? ` (${check.reason})` : ''}${evidence}`,
      ),
    );
  }
  for (const file of retro.changes.files) fixed.push(line(file.id, 'changed file', file.path));
  for (const commit of retro.changes.commits)
    fixed.push(line(commit.id, 'commit during the session', commit.subject));
  for (const comment of retro.review.comments)
    fixed.push(
      line(
        comment.id,
        `review comment (${comment.status}) ${comment.path}:${comment.line}`,
        comment.text,
      ),
    );
  const d = retro.delivery;
  fixed.push(
    `[none] delivery: local checks ${d.checks}; commit ${d.commit}; push ${d.push}; CI ${d.ci}; deploy ${d.deploy}`,
  );
  for (const step of retro.next) fixed.push(line(step.id, `next (${step.kind})`, step.text));

  const flexible: { seq: number; text: string }[] = [];
  for (const turn of retro.turns) {
    flexible.push({
      seq: turn.seq,
      text: line(
        turn.id,
        `turn (${turn.kind}, ${turn.outcome ?? 'running'}, ${turn.files.length} files, ${turn.commands} commands${turn.chapter ? `, in ${turn.chapter}` : ''})`,
        turn.text ?? '',
      ),
    });
  }
  for (const decision of retro.decisions) {
    flexible.push({
      seq: refSeq(decision.ref),
      text: line(decision.id, `user ${decision.kind}`, decision.text),
    });
  }
  for (const command of retro.verification.commands) {
    flexible.push({
      seq: refSeq(command.ref),
      text: line(
        command.id,
        `agent command (${command.status ?? 'running'}, not verification)`,
        command.text,
      ),
    });
  }
  flexible.sort((a, b) => a.seq - b.seq);

  const head = `<retro>\n${fixed.join('\n')}`;
  let budget = RETRO_SUMMARY_INPUT_MAX_BYTES - Buffer.byteLength(head, 'utf8') - 40;
  const kept: string[] = [];
  for (const { text: entry } of [...flexible].reverse()) {
    const size = Buffer.byteLength(entry, 'utf8') + 1;
    if (size > budget) break;
    kept.push(entry);
    budget -= size;
  }
  const omitted = flexible.length - kept.length;
  return `${head}\n${kept.reverse().join('\n')}${omitted > 0 ? `\n[none] ${omitted} earlier lines omitted` : ''}\n</retro>`;
}

function refSeq(ref: SessionRetro['decisions'][number]['ref']): number {
  return ref?.kind === 'event' ? ref.seq : 0;
}

/**
 * 解析模型的输出：第一个 `{` 到最后一个 `}` 之间的 JSON，`points` 是数组；每点的文字截到上限，`refs` 只留骨架里有的 ID（去重），
 * 一个都不剩时标 `inferred`。没有可用的点时 undefined。
 */
export function parseRetroSummary(
  output: string,
  knownIds: ReadonlySet<string>,
): RetroSummaryPoint[] | undefined {
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
  const points = (value as Record<string, unknown>).points;
  if (!Array.isArray(points)) return undefined;
  const result: RetroSummaryPoint[] = [];
  for (const point of points) {
    if (result.length >= RETRO_SUMMARY_MAX_POINTS) break;
    if (typeof point !== 'object' || point === null) continue;
    const { text, refs } = point as Record<string, unknown>;
    if (typeof text !== 'string') continue;
    const clipped = clipText(text, RETRO_SUMMARY_POINT_MAX_CHARS);
    if (clipped === '') continue;
    const valid = Array.isArray(refs)
      ? [
          ...new Set(
            refs.filter((ref): ref is string => typeof ref === 'string' && knownIds.has(ref)),
          ),
        ]
      : [];
    result.push({
      text: clipped,
      refs: valid,
      ...(valid.length === 0 && { inferred: true as const }),
    });
  }
  return result.length === 0 ? undefined : result;
}

/** 回顾里所有能被引用的 ID。 */
export function retroIds(retro: SessionRetro): Set<string> {
  const ids = new Set<string>();
  const add = (items: readonly { id: string }[]) => {
    for (const item of items) ids.add(item.id);
  };
  if (retro.goal.goal) ids.add(retro.goal.goal.id);
  if (retro.goal.request) ids.add(retro.goal.request.id);
  add(retro.done);
  add(retro.open);
  add(retro.turns);
  add(retro.chapters ?? []);
  add(retro.changes.files);
  add(retro.changes.commits);
  add(retro.verification.checks);
  add(retro.verification.commands);
  add(retro.review.comments);
  add(retro.decisions);
  add(retro.next);
  add(retro.sessions);
  add(retro.memories);
  return ids;
}
