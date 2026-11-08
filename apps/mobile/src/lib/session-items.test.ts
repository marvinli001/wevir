import type { ChatMessage, ChatPart, Transcript } from '@wevir/client-sdk';
import type { MessageFrom, PendingMessage, SessionId } from '@wevir/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { type SessionItemLabels, sessionItems, visibleItems } from './session-items';

const OWN = 'ses_own' as SessionId;
const OTHER = 'ses_other' as SessionId;

const LABELS: SessionItemLabels = {
  image: '图片',
  tool: () => undefined,
  sessionTitle: (id) => (id === OTHER ? '修登录页' : undefined),
};

function user(id: string, text: string, from?: MessageFrom): ChatMessage {
  return {
    role: 'user',
    id,
    turnId: 'trn_1',
    parts: [{ type: 'text', key: `${id}:t`, text }],
    ...(from !== undefined && { from }),
  } as unknown as ChatMessage;
}

function transcript(
  messages: ChatMessage[],
  pendingMessages: Partial<PendingMessage>[] = [],
): Transcript {
  return {
    sessionId: OWN,
    messages,
    pendingApprovals: [],
    pendingQuestions: [],
    pendingMessages,
  } as unknown as Transcript;
}

beforeAll(() => setLocale('zh-CN'));

describe('手机接力与额度部件', () => {
  it('保留接力、模型配置与额度错误，不改成普通错误', () => {
    const parts = [
      {
        type: 'notice',
        key: 'n:1',
        notice: {
          kind: 'configured',
          from: { providerId: 'api', modelId: 'm' },
          to: { providerId: 'api', modelId: 'n' },
        },
      },
      {
        type: 'notice',
        key: 'n:2',
        notice: {
          kind: 'handoff',
          fromProviderId: 'api',
          fromModelId: 'n',
          providerId: 'claude',
          modelId: 'm',
          strategy: 'full_thread_summary',
          resumed: false,
          items: 2,
          omittedItems: 0,
          delivery: { status: 'prepared' },
          reason: 'usage_limit',
        },
      },
      {
        type: 'error',
        key: 'e:1',
        message: 'quota',
        category: 'provider',
        fatal: false,
        turnId: 'trn_1',
        usageLimit: {},
        routedTo: { providerId: 'claude', modelId: 'm' },
        resumedAt: '2026-11-04T10:30:00Z',
      },
      { type: 'error', key: 'e:2', message: 'ordinary', category: 'provider', fatal: false },
    ] satisfies ChatPart[];
    const items = sessionItems(
      transcript([{ id: 'system', role: 'system', parts, seqRange: [1, 4] }]),
      LABELS,
    );
    expect(items).toEqual([
      { kind: 'handoff', key: 'n:1', notice: parts[0]?.notice },
      { kind: 'handoff', key: 'n:2', notice: parts[1]?.notice },
      { kind: 'usage-limit', key: 'e:1', part: parts[2] },
      { kind: 'error', key: 'e:2', text: 'ordinary' },
    ]);
  });
});

describe('sessionItems：不是用户写的消息', () => {
  it('后台进程的通知是一行标记，不是用户的气泡', () => {
    const text = '[Wevir] Background process p16 "server" exited with code 0 after 1m 40s.';
    const items = sessionItems(
      transcript([
        user('m1', text, {
          sessionId: OWN,
          kind: 'report',
          process: { id: 'p16', name: 'server', event: 'exit', exitCode: 0 },
        }),
      ]),
      LABELS,
    );
    expect(items).toEqual([
      {
        kind: 'notice',
        key: 'm1',
        icon: 'process',
        label: '后台进程“server”已退出（退出码 0）',
        text,
      },
    ]);
  });

  it('别的会话发来的消息与回报是卡片，回报只留那个会话的回答', () => {
    const report =
      'Session ses_other "修登录页" finished a turn you asked for (completed).\nIts final answer:\n\n改好了。' +
      '\n\nRead the whole conversation with wevir_session_read if you need more.';
    const items = sessionItems(
      transcript([
        user('m1', '帮我看看日志', { sessionId: OTHER, kind: 'message' }),
        user('m2', report, { sessionId: OTHER, kind: 'report' }),
        user('m3', report, { sessionId: OWN, kind: 'report' }),
      ]),
      LABELS,
    );
    expect(items).toEqual([
      {
        kind: 'relayed',
        key: 'm1',
        icon: 'message',
        label: '来自另一个会话的消息',
        source: '修登录页',
        text: '帮我看看日志',
      },
      {
        kind: 'relayed',
        key: 'm2',
        icon: 'report',
        label: '“修登录页”的回报',
        source: '修登录页',
        text: '改好了。',
      },
      { kind: 'relayed', key: 'm3', icon: 'report', label: '子会话的回报', text: '改好了。' },
    ]);
  });

  it('自动修复与第二意见是一行标记，第二意见的附言照常是气泡；额度恢复后的继续消息不显示', () => {
    const items = sessionItems(
      transcript([
        user('m1', 'checks failed', {
          sessionId: OWN,
          kind: 'report',
          repair: { attempt: 1, maxAttempts: 2 } as NonNullable<MessageFrom['repair']>,
        }),
        user('m2', '看看这个意见\n\nopinion', {
          sessionId: OTHER,
          kind: 'report',
          opinion: { opinionId: 'opn_1', note: '看看这个意见' } as NonNullable<
            MessageFrom['opinion']
          >,
        }),
        user('m3', 'continue', {
          sessionId: OWN,
          kind: 'report',
          usageLimit: { turnId: 'trn_0' } as NonNullable<MessageFrom['usageLimit']>,
        }),
      ]),
      LABELS,
    );
    expect(items.map((item) => [item.kind, 'label' in item ? item.label : item.key])).toEqual([
      ['notice', '自动修复 · 第 1/2 次'],
      ['user', 'm2:note'],
      ['notice', '第二意见'],
    ]);
  });

  it('待送达的通知只显示一行说明', () => {
    const items = sessionItems(
      transcript(
        [],
        [
          {
            id: 'pm_1',
            status: 'waiting',
            delivery: 'queue',
            content: [{ type: 'text', text: '[Wevir] Background process p2 printed 1 line' }],
            from: {
              sessionId: OWN,
              kind: 'report',
              process: { id: 'p2', name: 'tests', event: 'match' },
            },
          } as unknown as Partial<PendingMessage>,
          {
            id: 'pm_2',
            status: 'waiting',
            delivery: 'steer',
            content: [{ type: 'text', text: '顺便改标题' }],
          } as unknown as Partial<PendingMessage>,
        ],
      ),
      LABELS,
    );
    expect(items).toMatchObject([
      {
        kind: 'pending',
        pendingId: 'pm_1',
        notice: { icon: 'process', label: '后台进程“tests”输出匹配' },
      },
      { kind: 'pending', pendingId: 'pm_2', text: '顺便改标题' },
    ]);
    expect(items[1]).not.toHaveProperty('notice');
  });
});

function assistant(parts: unknown[], startedAt = '2026-11-02T10:00:00.000Z'): ChatMessage {
  return {
    role: 'assistant',
    id: 'a1',
    turnId: 'trn_1',
    startedAt,
    parts,
  } as unknown as ChatMessage;
}

function running(messages: ChatMessage[], patch: Partial<Transcript> = {}): Transcript {
  return {
    ...transcript(messages),
    state: 'running',
    activeTurnId: 'trn_1',
    ...patch,
  } as unknown as Transcript;
}

const shell = (status: string, output?: string) => ({
  type: 'tool',
  key: 'tool1',
  toolCallId: 'call1',
  toolName: 'exec_command',
  display: { kind: 'shell', command: 'pnpm test' },
  status,
  input: {},
  ...(output !== undefined && { output: { text: output, truncated: false } }),
  startedAt: '2026-11-02T10:00:01.000Z',
});

describe('sessionItems：工具执行回执', () => {
  it.each([
    { status: 'awaiting_approval', state: 'awaiting' },
    { status: 'running', state: 'running' },
    { status: 'completed', state: 'done' },
    { status: 'failed', state: 'failed' },
    { status: 'cancelled', state: 'skipped' },
    { status: 'unknown', state: 'unknown' },
    { status: 'failed', approvalStatus: 'denied', state: 'skipped' },
    { status: 'running', approvalStatus: 'approved', state: 'running' },
    { status: 'completed', approvalStatus: 'denied', state: 'done' },
  ])('$status / $approvalStatus → $state', ({ status, approvalStatus, state }) => {
    const part = {
      ...shell(status),
      ...(approvalStatus !== undefined && { approval: { status: approvalStatus } }),
    };
    const items = sessionItems(running([assistant([part])]), LABELS, { live: false });
    expect(items).toMatchObject([{ kind: 'tool', state }]);
  });
});

describe('sessionItems：回合进行中', () => {
  it('末尾是运行状态，正在流出的思考不另画一行，露在运行状态下面', () => {
    const items = sessionItems(
      running([
        user('m1', '查一下'),
        assistant([
          {
            type: 'reasoning',
            key: 's:1:0',
            text: '先看 **日志**\n再看配置',
            state: 'streaming',
            startedAt: '2026-11-02T10:00:00.000Z',
            endedAt: '2026-11-02T10:00:03.000Z',
          },
        ]),
      ]),
      LABELS,
    );
    expect(items.map((item) => item.kind)).toEqual(['user', 'live']);
    expect(items.at(-1)).toEqual({
      kind: 'live',
      key: 'live',
      action: { kind: 'thinking' },
      startedAt: '2026-11-02T10:00:00.000Z',
      detail: '先看 日志 再看配置',
    });
  });

  it('思考很长时只露末尾，前面写成省略号', () => {
    const text = `${'开头'.repeat(100)}最新的一句`;
    const items = sessionItems(
      running([assistant([{ type: 'reasoning', key: 's:1:0', text, state: 'streaming' }])]),
      LABELS,
    );
    const detail = (items.at(-1) as { detail: string }).detail;
    expect(detail.startsWith('…')).toBe(true);
    expect(detail.endsWith('最新的一句')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(66);
  });

  it('在跑的工具由运行状态代表（带最近一行输出），做完了才列进消息流', () => {
    const live = sessionItems(running([assistant([shell('running', 'PASS a\nRUN  b\n')])]), LABELS);
    expect(live).toEqual([
      {
        kind: 'live',
        key: 'live',
        action: { kind: 'tool', label: 'exec_command · pnpm test' },
        startedAt: '2026-11-02T10:00:00.000Z',
        detail: 'RUN b',
      },
    ]);
    const done = sessionItems(running([assistant([shell('completed')])]), LABELS);
    expect(done.map((item) => item.kind)).toEqual(['tool', 'live']);
    expect(done.at(-1)).toMatchObject({ action: { kind: 'thinking' } });
  });

  it('等审批、等回答、停止中', () => {
    const base = [assistant([shell('awaiting_approval')])];
    const approval = { id: 'apr_1', options: [], title: 'x' };
    expect(
      sessionItems(running(base, { pendingApprovals: [approval] } as never), LABELS).find(
        (item) => item.kind === 'live',
      ),
    ).toMatchObject({ action: { kind: 'awaiting' } });
    expect(
      sessionItems(running(base, { state: 'cancelling' }), LABELS).find(
        (item) => item.kind === 'live',
      ),
    ).toMatchObject({ action: { kind: 'stopping' } });
  });

  it('还在写的回答带 streaming，写完了的思考是一行带时长', () => {
    const items = sessionItems(
      running([
        assistant([
          {
            type: 'reasoning',
            key: 'r1',
            text: '想好了',
            state: 'done',
            startedAt: '2026-11-02T10:00:00.000Z',
            endedAt: '2026-11-02T10:00:04.500Z',
          },
          { type: 'text', key: 's:2:0', text: '答案是', state: 'streaming' },
        ]),
      ]),
      LABELS,
    );
    expect(items).toEqual([
      { kind: 'thought', key: 'r1', text: '想好了', durationMs: 4_500 },
      { kind: 'assistant', key: 's:2:0', text: '答案是', streaming: true },
      {
        kind: 'live',
        key: 'live',
        action: { kind: 'thinking' },
        startedAt: '2026-11-02T10:00:00.000Z',
      },
    ]);
  });

  it('回合结束后没有运行状态；没有文字又不到一秒的思考不占一行', () => {
    const items = sessionItems(
      transcript([
        assistant([
          {
            type: 'reasoning',
            key: 'r1',
            text: '',
            state: 'done',
            startedAt: '2026-11-02T10:00:00.000Z',
            endedAt: '2026-11-02T10:00:00.400Z',
          },
          { type: 'text', key: 't1', text: '好了', state: 'done' },
        ]),
      ]),
      LABELS,
    );
    expect(items).toEqual([{ kind: 'assistant', key: 't1', text: '好了' }]);
  });
});

function answer(id: string, turnId: string, parts: unknown[], finished?: unknown): ChatMessage {
  return {
    role: 'assistant',
    id,
    turnId,
    startedAt: '2026-11-02T10:00:00.000Z',
    parts,
    ...(finished !== undefined && { finished }),
  } as unknown as ChatMessage;
}

function ask(id: string, turnId: string, text: string): ChatMessage {
  return { ...user(id, text), turnId } as ChatMessage;
}

const thought = { type: 'reasoning', key: 'r1', text: '想想', state: 'done' };
const done = (key: string) => ({ ...shell('completed'), key });

describe('sessionItems：回合的折叠', () => {
  it('正常完成且有过程的回合：用户消息下面一行“已处理”，过程带 fold，默认收起只留回答', () => {
    const items = sessionItems(
      transcript([
        ask('m1', 'trn_1', '修一下'),
        answer(
          'a1',
          'trn_1',
          [
            thought,
            { type: 'text', key: 't1', text: '我先跑测试', state: 'done' },
            done('tool1'),
            { type: 'text', key: 't2', text: '修好了', state: 'done' },
          ],
          { outcome: 'completed', durationMs: 151_000 },
        ),
      ]),
      LABELS,
    );
    expect(items.map((item) => [item.kind, item.fold])).toEqual([
      ['user', undefined],
      ['turn', undefined],
      ['thought', 'turn:trn_1'],
      ['assistant', 'turn:trn_1'],
      ['tool', 'turn:trn_1'],
      ['assistant', undefined],
    ]);
    expect(items[1]).toEqual({
      kind: 'turn',
      key: 'turn:trn_1',
      outcome: 'completed',
      durationMs: 151_000,
      defaultOpen: false,
    });
    expect(visibleItems(items, new Map()).map((item) => item.key)).toEqual([
      'm1',
      'turn:trn_1',
      't2',
    ]);
    expect(visibleItems(items, new Map([['turn:trn_1', true]]))).toHaveLength(6);
  });

  it('出错的回合默认展开；没有过程的正常回合不加那一行；进行中的回合不加', () => {
    const failed = sessionItems(
      transcript([
        ask('m1', 'trn_1', '跑一下'),
        answer('a1', 'trn_1', [done('tool1')], { outcome: 'failed', durationMs: 12_000 }),
      ]),
      LABELS,
    );
    expect(failed[1]).toMatchObject({ kind: 'turn', outcome: 'failed', defaultOpen: true });
    expect(visibleItems(failed, new Map())).toHaveLength(3);

    const plain = sessionItems(
      transcript([
        ask('m1', 'trn_1', '你好'),
        answer('a1', 'trn_1', [{ type: 'text', key: 't1', text: '你好', state: 'done' }], {
          outcome: 'completed',
          durationMs: 2_000,
        }),
      ]),
      LABELS,
    );
    expect(plain.map((item) => item.kind)).toEqual(['user', 'assistant']);

    const busy = sessionItems(
      running([ask('m1', 'trn_1', '跑一下'), answer('a1', 'trn_1', [done('tool1')])]),
      LABELS,
    );
    expect(busy.map((item) => item.kind)).toEqual(['user', 'tool', 'live']);
  });

  it('只有用户消息就被停止的回合：那一行跟在用户消息后面', () => {
    const items = sessionItems(
      transcript([
        ask('m1', 'trn_1', '跑一下'),
        answer('a1', 'trn_1', [], { outcome: 'cancelled', durationMs: 1_000 }),
        ask('m2', 'trn_2', '算了'),
      ]),
      LABELS,
    );
    expect(items.map((item) => item.key)).toEqual(['m1', 'turn:trn_1', 'm2']);
  });

  it('不挂起回合的提问的回答不显示，不画成回报', () => {
    const from = {
      sessionId: OWN,
      kind: 'report',
      question: { questionId: 'q_1' },
    } as unknown as MessageFrom;
    const items = sessionItems(
      transcript(
        [user('m1', '[Wevir] answer', from)],
        [
          {
            id: 'pm_1',
            status: 'waiting',
            delivery: 'queue',
            content: [{ type: 'text', text: '[Wevir] answer' }],
            from,
          } as unknown as Partial<PendingMessage>,
        ],
      ),
      LABELS,
    );
    expect(items).toEqual([]);
  });
});
