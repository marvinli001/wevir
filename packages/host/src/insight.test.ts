import type { SessionInsight, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from './handoff.js';
import {
  INSIGHT_INPUT_MAX_BYTES,
  INSIGHT_MIN_INTERVAL_MS,
  insightHistory,
  insightInput,
  insightItems,
  loadInsightInstructions,
  parseInsight,
  shouldCheck,
} from './insight.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN2 = 'trn_01JA2B3C4D5E6F7G8H9JKMNPR1';
const TS = '2026-10-21T08:00:00.000Z';

let seq = 0;
function event(type: string, payload: object, source = 'host'): WevirEvent {
  seq += 1;
  return { seq, sessionId: SESSION, ts: TS, type, source, payload } as unknown as WevirEvent;
}

const user = (turnId: string, text: string) =>
  event('user.message', {
    turnId,
    content: [{ type: 'text', text }],
    sentBy: { deviceId: 'd', clientId: 'c', clientKind: 'desktop' },
  });
const shell = (turnId: string, command: string) =>
  event(
    'tool.started',
    {
      turnId,
      toolCallId: `call_${seq}`,
      toolName: 'shell',
      display: { kind: 'shell', command },
      input: {},
    },
    'engine',
  );

function item(seqNo: number, kind: HistoryItem['kind'], text: string): HistoryItem {
  return {
    itemId: `e${seqNo}`,
    seq: seqNo,
    turnId: TURN,
    role: kind === 'user_message' ? 'user' : 'assistant',
    kind,
    text,
  };
}

const insight = (overrides: Partial<SessionInsight> = {}): SessionInsight => ({
  id: 'isg_01JA2B3C4D5E6F7G8H9JKMNPQR',
  turnId: TURN,
  tag: 'heads_up',
  summary: 'agent 改了全局的 npm 设置。',
  title: '全局 npm 设置被改了',
  detail: '- 写进了 ~/.npmrc',
  status: 'known',
  throughSeq: 10,
  createdAt: TS,
  updatedAt: TS,
  ...overrides,
});

describe('loadInsightInstructions', () => {
  it('读仓库里的提示词：去掉文件头注释，没有残留的模板语法', () => {
    const text = loadInsightInstructions();
    expect(text.startsWith('你是 Wevir 会话的旁观者')).toBe(true);
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('{{');
    expect(text).toContain('"show": false');
  });
});

describe('insightItems', () => {
  it('只留消息、命令、文件改动与错误；撤回与撤销的回合不算，重做的算回来', () => {
    const events = [
      user(TURN, '修好构建'),
      shell(TURN, 'npm config set legacy-peer-deps true'),
      user(TURN2, '换个办法'),
      shell(TURN2, 'rm -rf node_modules'),
      event('turn.undone', { turnId: TURN2 }),
    ];
    expect(insightItems(events).map((entry) => entry.text)).toEqual([
      '修好构建',
      'Command: npm config set legacy-peer-deps true',
    ]);
    const redone = [...events, event('turn.redone', { turnId: TURN2 })];
    expect(insightItems(redone)).toHaveLength(4);
    const rewound = [...events, event('turn.rewound', { turnId: TURN })];
    expect(insightItems(rewound)).toEqual([]);
  });
});

describe('insightInput', () => {
  it('消息与动作按先后，转义尖括号；带结局、提过的与已知的', () => {
    const input = insightInput(
      [
        item(1, 'user_message', '修好 <build>'),
        item(2, 'command', 'Command: pnpm test'),
        item(3, 'assistant_message', '好了'),
      ],
      'completed',
      insightHistory([
        insight(),
        insight({ status: 'dismissed', summary: '只跑了一部分测试。', title: '测试没跑全' }),
      ]),
    );
    expect(input).toBe(
      [
        '<conversation>',
        '<message role="user">修好 &lt;build&gt;</message>',
        '<action>Command: pnpm test</action>',
        '<message role="assistant">好了</message>',
        '</conversation>',
        '<state>',
        'last_turn: completed',
        '</state>',
        '<offered>',
        '- agent 改了全局的 npm 设置。',
        '- 只跑了一部分测试。',
        '</offered>',
        '<known>',
        '- 全局 npm 设置被改了：agent 改了全局的 npm 设置。',
        '</known>',
      ].join('\n'),
    );
  });

  it('没有提过的写 (none)；超出预算时从最早的丢，最新的一条留着；长回答两头都留', () => {
    const long = `开头${'中'.repeat(3000)}结尾`;
    const items = Array.from({ length: 40 }, (_, index) =>
      item(index + 1, 'assistant_message', `${index}:${long}`),
    );
    const input = insightInput(items, undefined, { offered: [], known: [] });
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThanOrEqual(INSIGHT_INPUT_MAX_BYTES);
    expect(input).toContain('<offered>\n(none)\n</offered>');
    expect(input).toContain('39:开头');
    expect(input).not.toContain('0:开头');
    expect(input).toMatch(/…中+结尾<\/message>\n<\/conversation>/u);
  });
});

describe('parseInsight', () => {
  const output = (fields: object) =>
    JSON.stringify({
      show: true,
      tag: 'heads_up',
      summary: '只跑了登录目录下的测试。',
      title: '只跑了登录相关的测试',
      detail: '其余的**没跑**。',
      ...fields,
    });

  it('取出四个字段；标题去掉句末标点与引号，一句话折叠空白', () => {
    expect(
      parseInsight(
        `\`\`\`json\n${output({ title: '“只跑了登录相关的测试。”', summary: ' 只跑了\n登录目录 ' })}\n\`\`\``,
      ),
    ).toEqual({
      tag: 'heads_up',
      summary: '只跑了 登录目录',
      title: '只跑了登录相关的测试',
      detail: '其余的**没跑**。',
    });
  });

  it('模型说没有、标签不认识、字段为空或缺、不是 JSON：都算没有', () => {
    expect(
      parseInsight('{"show": false, "tag": "", "summary": "", "title": "", "detail": ""}'),
    ).toBeUndefined();
    expect(parseInsight(output({ tag: 'fyi' }))).toBeUndefined();
    expect(parseInsight(output({ detail: '  ' }))).toBeUndefined();
    expect(parseInsight(output({ title: undefined }))).toBeUndefined();
    expect(parseInsight('learn: none')).toBeUndefined();
    expect(parseInsight('{"show": true')).toBeUndefined();
  });

  it('超长的截断，像密钥的片段遮掉', () => {
    const parsed = parseInsight(
      output({
        summary: '中'.repeat(400),
        detail: 'Key 是 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      }),
    );
    expect(parsed?.summary).toHaveLength(300);
    expect(parsed?.summary.endsWith('…')).toBe(true);
    expect(parsed?.detail).toContain('[REDACTED]');
    expect(parsed?.detail).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('shouldCheck', () => {
  const actions = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => item(from + index, 'command', 'Command: ls'));

  it('agent 又做了至少 3 件事才检查；从上次检查的位置数起，没有记录时从最近一条提示数起', () => {
    expect(shouldCheck({ now: 0, last: undefined, items: actions(1, 2), insights: [] })).toBe(
      false,
    );
    expect(shouldCheck({ now: 0, last: undefined, items: actions(1, 3), insights: [] })).toBe(true);
    expect(
      shouldCheck({
        now: INSIGHT_MIN_INTERVAL_MS,
        last: { at: 0, throughSeq: 2 },
        items: actions(1, 4),
        insights: [],
      }),
    ).toBe(false);
    expect(
      shouldCheck({ now: 0, last: undefined, items: actions(9, 4), insights: [insight()] }),
    ).toBe(false);
    expect(
      shouldCheck({ now: 0, last: undefined, items: actions(9, 5), insights: [insight()] }),
    ).toBe(true);
  });

  it('距上次不到 10 分钟、或还有没处理的一条时不检查', () => {
    const items = actions(1, 10);
    expect(
      shouldCheck({
        now: INSIGHT_MIN_INTERVAL_MS - 1,
        last: { at: 0, throughSeq: 0 },
        items,
        insights: [],
      }),
    ).toBe(false);
    expect(
      shouldCheck({
        now: INSIGHT_MIN_INTERVAL_MS,
        last: { at: 0, throughSeq: 0 },
        items,
        insights: [],
      }),
    ).toBe(true);
    expect(
      shouldCheck({
        now: 0,
        last: undefined,
        items,
        insights: [insight({ status: 'open', throughSeq: 0 })],
      }),
    ).toBe(false);
  });
});
