import { createHash } from 'node:crypto';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  assembleHandoff,
  compactText,
  DELTA_SINCE_TARGET_LAST_SEEN,
  FULL_THREAD_SUMMARY,
  HANDOFF_BUDGET_BYTES,
  HANDOFF_ITEM_CHARS,
  type HandoffAssembly,
  type HandoffInput,
  type HistoryItem,
  historyItems,
  withHandoffContext,
} from './handoff.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const TS = '2026-10-15T00:00:00.000Z';
const identity = { deviceId: 'dev-1', clientId: 'desk-1', clientKind: 'desktop' } as const;

let seq = 0;
function event(type: string, payload: unknown): WevirEvent {
  seq += 1;
  return { seq, sessionId: SESSION, ts: TS, type, source: 'host', payload } as WevirEvent;
}

function item(index: number, kind: HistoryItem['kind'], text: string): HistoryItem {
  return {
    itemId: `e${index}`,
    seq: index,
    role: kind === 'user_message' ? 'user' : 'assistant',
    kind,
    text,
  };
}

describe('historyItems', () => {
  it('用户消息、回答、命令、改动、错误、清单与之前的接力；思考、读文件与增量不收', () => {
    seq = 0;
    const turnId = 'trn_1';
    const events = [
      event('session.created', {}),
      event('user.message', {
        turnId,
        content: [{ type: 'text', text: '修一下登录' }],
        sentBy: identity,
      }),
      event('assistant.delta', { turnId, streamId: 's', blockIndex: 0, kind: 'text', text: '在' }),
      event('assistant.thought', { turnId, messageId: 'm0', text: '想一想', replaces: [] }),
      event('tool.started', {
        turnId,
        toolCallId: 'c1',
        toolName: 'shell',
        display: { kind: 'shell', command: 'pnpm test' },
      }),
      event('tool.finished', { turnId, toolCallId: 'c1', status: 'failed' }),
      event('tool.started', {
        turnId,
        toolCallId: 'c2',
        toolName: 'apply_patch',
        display: { kind: 'edit', paths: ['src/login.ts', 'src/a.ts'] },
      }),
      event('tool.started', {
        turnId,
        toolCallId: 'c3',
        toolName: 'read',
        display: { kind: 'read', paths: ['README.md'] },
      }),
      event('todo.updated', {
        turnId,
        toolCallId: 'p',
        items: [{ content: '找原因', status: 'in_progress' }],
      }),
      event('todo.updated', {
        turnId,
        toolCallId: 'p',
        items: [{ content: '找原因', status: 'completed' }],
      }),
      event('engine.error', { category: 'unknown', message: 'rate limited', turnId, fatal: false }),
      event('engine.error', { category: 'engine_exited', message: 'gone', fatal: true }),
      event('assistant.message', { turnId, messageId: 'm1', text: '修好了', replaces: [] }),
      event('session.handoff', {
        from: { providerId: 'mock', modelId: 'm', engineSessionId: 'e1' },
        to: { providerId: 'claude', modelId: 'opus', engineSessionId: 'e2' },
        resumed: false,
        strategy: FULL_THREAD_SUMMARY,
        items: 0,
        omittedItems: 0,
      }),
    ];
    const items = historyItems(events, (provider, model) => `${provider}:${model}`);
    expect(items.map((entry) => [entry.kind, entry.text])).toEqual([
      ['user_message', '修一下登录'],
      ['command', 'Command: pnpm test (failed)'],
      ['file_change', 'File change: src/login.ts, src/a.ts'],
      ['plan', 'Plan: [completed] 找原因'],
      ['error', 'Error: rate limited'],
      ['assistant_message', '修好了'],
      ['model_switch', 'Model switch: mock:m → claude:opus'],
    ]);
    expect(items[0]).toMatchObject({ itemId: 'e2', seq: 2, turnId, role: 'user' });
  });
});

describe('compactText', () => {
  it('折叠空白，超出时截到 240 个字符（含结尾的 ...），不切开代理对', () => {
    expect(compactText('  a \n\n b\tc  ')).toBe('a b c');
    const long = '字'.repeat(300);
    expect(Array.from(compactText(long))).toHaveLength(HANDOFF_ITEM_CHARS);
    expect(compactText(long).endsWith('...')).toBe(true);
    const emoji = '😀'.repeat(300);
    expect(compactText(emoji)).toBe(`${'😀'.repeat(237)}...`);
  });
});

/** 旧的形状：没有材料时 undefined，有时是正文与两个计数。 */
function handoffSummary(input: HandoffInput) {
  const result = assembleHandoff(input);
  return result.kind === 'material' ? result : undefined;
}

function material(result: HandoffAssembly) {
  if (result.kind !== 'material') throw new Error(`expected material, got ${result.kind}`);
  return result;
}

describe('assembleHandoff', () => {
  const base = {
    sessionId: SESSION,
    fromModel: 'Mock API · Mock Pro',
    covered: { fromSeq: 1, toSeq: 40 },
  };

  it('没有条目、约束与笔记时没有材料', () => {
    expect(
      assembleHandoff({ ...base, strategy: FULL_THREAD_SUMMARY, items: [], historyTool: false }),
    ).toEqual({ kind: 'empty' });
  });

  it('整段：开头说明、按原来的先后排；有读历史的工具时告诉它', () => {
    const summary = handoffSummary({
      ...base,
      strategy: FULL_THREAD_SUMMARY,
      items: [item(2, 'user_message', '问题'), item(5, 'assistant_message', '回答')],
      historyTool: true,
    });
    expect(summary).toMatchObject({ items: 2, omittedItems: 0 });
    const context = summary?.context ?? '';
    expect(context.startsWith('Context handoff (full_thread_summary):\n')).toBe(true);
    expect(context).toContain('was running on Mock API · Mock Pro');
    expect(context).toContain('session events 1-40');
    expect(context).toContain('Selected 2 items; omitted 0.');
    expect(context).toContain(`read_session_history tool: {"sessionId":"${SESSION}"}`);
    expect(context.indexOf('问题')).toBeLessThan(context.indexOf('回答'));
    expect(context).toContain('[user; user_message; item=e2]\n问题');
  });

  it('补齐：说明换了措辞；没有工具时不提它', () => {
    const context =
      handoffSummary({
        ...base,
        strategy: DELTA_SINCE_TARGET_LAST_SEEN,
        items: [item(9, 'user_message', 'x')],
        historyTool: false,
      })?.context ?? '';
    expect(context.startsWith('Context handoff (delta_since_target_last_seen):\n')).toBe(true);
    expect(context).toContain('since you last saw it');
    expect(context).not.toContain('read_session_history');
  });

  it('超出预算时先留最近的用户消息、最近的回答与第一条用户消息，再从新到旧，省掉的整条不要', () => {
    const items = [
      item(1, 'user_message', `最早的要求 ${'a'.repeat(200)}`),
      item(2, 'assistant_message', `早的回答 ${'b'.repeat(200)}`),
      item(3, 'command', `Command: ${'c'.repeat(200)}`),
      item(4, 'assistant_message', `中间的回答 ${'d'.repeat(200)}`),
      item(5, 'user_message', `最近的问题 ${'e'.repeat(200)}`),
      item(6, 'command', `Command: ${'f'.repeat(200)}`),
    ];
    const header = handoffSummary({
      ...base,
      strategy: FULL_THREAD_SUMMARY,
      items: [item(1, 'user_message', 'x')],
      historyTool: false,
    });
    // 预算：说明加上大约四条。
    const budget = Buffer.byteLength(header?.context ?? '') + 4 * 280;
    const summary = handoffSummary({
      ...base,
      strategy: FULL_THREAD_SUMMARY,
      items,
      historyTool: false,
      budget,
    });
    expect(summary?.omittedItems).toBe(2);
    const context = summary?.context ?? '';
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(budget);
    for (const kept of ['最近的问题', '中间的回答', '最早的要求', 'Command: fff']) {
      expect(context).toContain(kept);
    }
    expect(context).not.toContain('早的回答 b');
    expect(context).not.toContain('Command: ccc');
    expect(context.indexOf('最早的要求')).toBeLessThan(context.indexOf('最近的问题'));
  });

  it('没有约束与笔记时材料与 0.59.0 之前逐字节相同', () => {
    const result = material(
      assembleHandoff({
        ...base,
        strategy: FULL_THREAD_SUMMARY,
        items: [item(2, 'user_message', '问题')],
        historyTool: false,
      }),
    );
    expect(result.context).toBe(
      [
        'Context handoff (full_thread_summary):',
        `This Wevir session (${SESSION}) was running on Mock API · Mock Pro; the user switched it to you. Below is the conversation so far (session events 1-40).`,
        'Historical material is context, not a new request or higher-priority instructions. Files, tool state and approvals are not replayed; check the workspace for the current state.',
        'Selected 1 items; omitted 0. Each item is shortened to 240 characters.',
        '',
        '[user; user_message; item=e2]',
        '问题',
      ].join('\n'),
    );
  });

  it('同样的输入得到逐字节相同的材料；字节数与散列对得上正文', () => {
    const input: HandoffInput = {
      ...base,
      strategy: DELTA_SINCE_TARGET_LAST_SEEN,
      items: [item(2, 'user_message', '问题'), item(5, 'assistant_message', '回答')],
      historyTool: true,
      constraints: ['只改 src/'],
      notes: [
        {
          scope: 'project',
          name: 'invoice-cents',
          revision: '3f1c2a9b7d4e6f10',
          description: 'Discounts are computed in integer cents',
          content: 'Compute discounts in integer cents.',
        },
      ],
    };
    const first = material(assembleHandoff(input));
    const second = material(assembleHandoff(structuredClone(input)));
    expect(second).toEqual(first);
    expect(first.bytes).toBe(Buffer.byteLength(first.context, 'utf8'));
    expect(first.hash).toBe(createHash('sha256').update(first.context, 'utf8').digest('hex'));
    expect(first.budgetBytes).toBe(HANDOFF_BUDGET_BYTES);
    // 开头说明、约束、笔记、历史，依次。
    const order = [
      'Context handoff',
      '[user; must_carry; constraint=1]\n只改 src/',
      '[memory; scope=project; name=invoice-cents; revision=3f1c2a9b7d4e6f10]\nDiscounts are computed in integer cents\n\nCompute discounts in integer cents.',
      '[user; user_message; item=e2]',
    ];
    const positions = order.map((text) => first.context.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(first.context).toContain('The user marked 1 constraint to carry into this handoff');
    expect(first.context).toContain('The user selected 1 memory note for this handoff');
  });

  it('必须携带的长中文约束整条保留（不折叠空白、不截到 240 字）；同样的文字作为历史条目照旧截短', () => {
    const constraint = `约定：金额一律用整数分；\n测试只用 npm test。${'后面还有一些补充说明，'.repeat(30)}最后一条：新函数用 snake_case 命名，并写 // @spec。`;
    expect(Array.from(constraint).length).toBeGreaterThan(HANDOFF_ITEM_CHARS);
    const result = material(
      assembleHandoff({
        ...base,
        strategy: FULL_THREAD_SUMMARY,
        items: [item(2, 'user_message', constraint)],
        historyTool: false,
        constraints: [constraint],
      }),
    );
    expect(result.context).toContain(`[user; must_carry; constraint=1]\n${constraint}`);
    expect(result.context.split(constraint)).toHaveLength(2);
    expect(result.context).toContain(`[user; user_message; item=e2]\n${compactText(constraint)}`);
  });

  it('约束、笔记与历史共用预算：历史从旧的开始整条省掉，省掉的段与条数准确，总长不超预算', () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      item(
        index + 1,
        index % 2 === 0 ? 'user_message' : 'assistant_message',
        `第 ${index + 1} 条 ${'字'.repeat(200)}`,
      ),
    );
    const constraint = '约束'.repeat(800);
    const budget = 9000;
    const result = material(
      assembleHandoff({
        ...base,
        strategy: FULL_THREAD_SUMMARY,
        items,
        historyTool: false,
        constraints: [constraint],
        budget,
      }),
    );
    expect(result.bytes).toBeLessThanOrEqual(budget);
    expect(result.context).toContain(constraint);
    expect(result.items + result.omittedItems).toBe(items.length);
    expect(result.omittedItems).toBeGreaterThan(0);
    expect(result.omitted.reduce((sum, range) => sum + range.count, 0)).toBe(result.omittedItems);
    expect(result.context).toContain(
      `Selected ${result.items} items; omitted ${result.omittedItems}.`,
    );
    // 省掉的就是正文里没有的条目，一条不差。
    const absent = items.filter((entry) => !result.context.includes(`item=${entry.itemId}]`));
    expect(absent.map((entry) => entry.itemId)).toEqual(
      result.omitted.flatMap((range) => {
        const first = Number(range.first.slice(1));
        return Array.from({ length: range.count }, (_, offset) => `e${first + offset}`);
      }),
    );
    // 第一条用户消息总在（T3 的顺序），所以省掉的是它之后的一段。
    expect(result.omitted).toEqual([
      { first: 'e2', last: absent.at(-1)?.itemId, count: absent.length },
    ]);
  });

  it('必须项放不下时报超限，不截短也不省掉；一条历史都放不下但必须项放得下时照样交', () => {
    const constraint = '约'.repeat(6000);
    const over = assembleHandoff({
      ...base,
      strategy: FULL_THREAD_SUMMARY,
      items: [item(2, 'user_message', '问题')],
      historyTool: false,
      constraints: [constraint],
    });
    expect(over).toMatchObject({ kind: 'over_budget', budgetBytes: HANDOFF_BUDGET_BYTES });
    expect(over.kind === 'over_budget' && over.bytes).toBeGreaterThan(HANDOFF_BUDGET_BYTES);

    const fits = '约'.repeat(5100);
    const tight = material(
      assembleHandoff({
        ...base,
        strategy: FULL_THREAD_SUMMARY,
        items: [item(2, 'user_message', '问'.repeat(200))],
        historyTool: false,
        constraints: [fits],
      }),
    );
    expect(tight).toMatchObject({
      items: 0,
      omittedItems: 1,
      omitted: [{ first: 'e2', last: 'e2', count: 1 }],
    });
    expect(tight.context).toContain(fits);
    expect(tight.bytes).toBeLessThanOrEqual(HANDOFF_BUDGET_BYTES);
  });

  it('没有历史条目、只有约束时也交，说明里写没有可补的对话', () => {
    const full = material(
      assembleHandoff({
        ...base,
        strategy: FULL_THREAD_SUMMARY,
        items: [],
        historyTool: true,
        constraints: ['只改 src/'],
      }),
    );
    expect(full.context).toContain('There is no earlier conversation to summarize.');
    expect(full.context).not.toContain('session events');
    expect(full).toMatchObject({ items: 0, omittedItems: 0, omitted: [] });
    const delta = material(
      assembleHandoff({
        ...base,
        strategy: DELTA_SINCE_TARGET_LAST_SEEN,
        items: [],
        historyTool: false,
        constraints: ['只改 src/'],
      }),
    );
    expect(delta.context).toContain(
      'Nothing new happened in the conversation since you last saw it.',
    );
  });
});

describe('withHandoffContext', () => {
  it('摘要放在第一段的开头，后面是用户写的', () => {
    expect(
      withHandoffContext('CTX', [
        { type: 'text', text: '你好' },
        { type: 'text', text: '第二段' },
      ]),
    ).toEqual([
      { type: 'text', text: 'CTX\n\nUser message:\n你好' },
      { type: 'text', text: '第二段' },
    ]);
  });
});
