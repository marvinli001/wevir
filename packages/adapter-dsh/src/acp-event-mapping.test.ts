// docs/architecture/acp-event-mapping.md 的四张表与代码一致：§1 类型（以样本跑映射核对事件类型）、
// §2 工具名 → 展示类型（与 DSH_TOOLS 双向一致）、§3 错误归类（与 TURN_ERROR_RULES 逐条一致，样本归到所在行）、
// §6 resume 失败的归类（与 RESUME_ERROR_RULES 逐条一致，样本归到所在行）。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type AcpSessionNotification,
  isAcpSessionNotification,
  MAPPED_ACP_UPDATES,
  mapAcpUpdate,
  RAW_BY_DESIGN_ACP_UPDATES,
} from './acp-mapping.js';
import { classifyResumeError, RESUME_ERROR_RULES, type ResumeFailure } from './resume-error.js';
import { readFixture, readTranscript } from './test-fixtures/acp-fixtures.js';
import { DSH_TOOLS, toolDisplay } from './tool-display.js';
import { classifyTurnError, TURN_ERROR_RULES } from './turn-error.js';

const DOC = readFileSync(
  fileURLToPath(new URL('../../../docs/architecture/acp-event-mapping.md', import.meta.url)),
  'utf8',
);

/** 某一节（`## <n>.`）里第一张表的数据行，每行按列切开；`\|` 是单元格里的竖线。 */
function table(section: number): string[][] {
  const start = DOC.indexOf(`\n## ${section}. `);
  const end = DOC.indexOf('\n## ', start + 1);
  const lines = DOC.slice(start, end === -1 ? undefined : end).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replaceAll('\\|', '|')),
    );
  }
  return rows;
}

/** 单元格里所有反引号包住的片段。 */
const codes = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);

describe('acp-event-mapping.md 与代码一致', () => {
  it('§1：类型表覆盖映射的全部类型，样本跑出来的事件类型都在表里写着', () => {
    const rows = table(1);
    const kinds = rows.map(([kind]) => codes(kind ?? '')[0]);
    expect(kinds.sort()).toEqual([...MAPPED_ACP_UPDATES, ...RAW_BY_DESIGN_ACP_UPDATES].sort());
    for (const [kindCell = '', eventsCell = '', , samplesCell = ''] of rows) {
      const kind = codes(kindCell)[0] as string;
      const listed = codes(eventsCell);
      const notifications: AcpSessionNotification[] = [];
      for (const sample of codes(samplesCell)) {
        if (sample.endsWith('.jsonl')) {
          for (const line of readTranscript(sample)) {
            const params = line.msg.params;
            if (isAcpSessionNotification(params) && params.update.sessionUpdate === kind) {
              notifications.push(params);
            }
          }
        } else {
          notifications.push(readFixture<AcpSessionNotification>(sample));
        }
      }
      if (notifications.length === 0) {
        notifications.push({ sessionId: 's', update: { sessionUpdate: kind } });
      }
      const produced = new Set(notifications.flatMap((n) => mapAcpUpdate(n).map((e) => e.type)));
      expect(
        [...produced].every((type) => listed.includes(type)),
        kind,
      ).toBe(true);
      expect(produced.has(listed[0] as never), kind).toBe(true);
    }
  });

  it('§2：工具名 → 展示类型与 DSH_TOOLS 一致', () => {
    const documented: Record<string, string> = {};
    let mcpKind: string | undefined;
    for (const [namesCell = '', kindCell = ''] of table(2)) {
      const kind = codes(kindCell)[0] as string;
      for (const name of codes(namesCell)) {
        if (name.startsWith('mcp__')) mcpKind = kind;
        else documented[name] = kind;
      }
    }
    const coded = Object.fromEntries(
      Object.entries(DSH_TOOLS).map(([name, rule]) => [name, rule.kind]),
    );
    expect(documented).toEqual(coded);
    expect(toolDisplay('mcp__github__create_issue', {}).kind).toBe(mcpKind);
    expect(toolDisplay('no_such_tool', {}).kind).toBe('unknown');
  });

  it('§3：错误归类规则逐条一致，样本归到所在行的类别', () => {
    const rows = table(3);
    const documented = rows.flatMap(([category = '', patternCell = '']) => {
      const pattern = codes(patternCell).find((code) => code.startsWith('/'));
      return pattern === undefined ? [] : [[codes(category)[0], pattern]];
    });
    expect(documented).toEqual(
      TURN_ERROR_RULES.map((rule) => [rule.category, String(rule.pattern)]),
    );
    for (const [categoryCell = '', , , samplesCell = ''] of rows) {
      for (const sample of codes(samplesCell)) {
        const { error } = readFixture<{ error: unknown }>(sample);
        expect(classifyTurnError(error).category, sample).toBe(codes(categoryCell)[0]);
      }
    }
  });

  it('§6：resume 失败的归类规则逐条一致，样本归到所在行', () => {
    const failureOf = (cell: string): ResumeFailure => {
      const [kind, reason] = codes(cell);
      return (
        kind === 'lost' ? { kind, reason } : { kind: kind as ResumeFailure['kind'] }
      ) as ResumeFailure;
    };
    const rows = table(6);
    const documented = rows.flatMap(([failureCell = '', codeCell = '', patternCell = '']) => {
      const pattern = codes(patternCell).find((code) => code.startsWith('/'));
      return pattern === undefined
        ? []
        : [[failureOf(failureCell), Number(codes(codeCell)[0]), pattern]];
    });
    expect(documented).toEqual(
      RESUME_ERROR_RULES.map((rule) => [rule.failure, rule.code, String(rule.pattern)]),
    );
    for (const [failureCell = '', , , , , samplesCell = ''] of rows) {
      for (const sample of codes(samplesCell)) {
        const { error } = readFixture<{ error: unknown }>(sample);
        expect(classifyResumeError(error).failure, sample).toEqual(failureOf(failureCell));
      }
    }
  });
});
