import type { SessionId, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  analyzeSession,
  loadRecapInstructions,
  parseRecap,
  RECAP_ASSISTANT_CHARS,
  RECAP_CACHE_SIZE,
  RECAP_INPUT_MAX_BYTES,
  RECAP_MAX_CHARS,
  RECAP_MAX_MESSAGES,
  RECAP_USER_CHARS,
  RecapCache,
  recapInput,
  splitSentences,
} from './recap.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const TS = '2026-10-18T00:00:00.000Z';
const identity = { deviceId: 'dev-1', clientId: 'desk-1', clientKind: 'desktop' } as const;

let seq = 0;
function event(type: string, payload: unknown): WevirEvent {
  seq += 1;
  return { seq, sessionId: SESSION, ts: TS, type, source: 'host', payload } as WevirEvent;
}

/** 一个完整的回合：用户消息、回答、结束。 */
function turn(id: string, user: string, answer: string, outcome = 'completed'): WevirEvent[] {
  return [
    event('turn.started', { turnId: id }),
    event('user.message', {
      turnId: id,
      content: [{ type: 'text', text: user }],
      sentBy: identity,
    }),
    event('assistant.message', { turnId: id, messageId: `m-${id}`, text: answer }),
    event('turn.finished', { turnId: id, outcome }),
  ];
}

describe('loadRecapInstructions', () => {
  it('读仓库里的 session-recap.md：去掉文件头的注释，不残留模板记号', () => {
    const text = loadRecapInstructions();
    expect(text.startsWith('你为 Wevir 写“离开后摘要”')).toBe(true);
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('{{');
    expect(text).toContain('{"recap": "摘要"}');
  });
});

describe('analyzeSession', () => {
  it('数看得见的回合：撤回的、撤销的不算，重做的算回来；取消息、结局和未做完的清单', () => {
    seq = 0;
    const events = [
      event('session.created', {}),
      ...turn('t1', '第一件事', '第一件做完了'),
      ...turn('t2', '第二件事', '第二件做完了'),
      event('todo.updated', {
        turnId: 't2',
        toolCallId: 'p1',
        items: [
          { content: '写测试', status: 'completed' },
          { content: '跑 CI', status: 'in_progress' },
          { content: '发布', status: 'pending' },
          { content: '不做了', status: 'cancelled' },
        ],
      }),
      ...turn('t3', '第三件事', '第三件失败了', 'failed'),
    ];
    const all = analyzeSession(events);
    expect(all.turns).toBe(3);
    expect(all.lastOutcome).toBe('failed');
    expect(all.marker).toBe(events.at(-1)?.seq);
    expect(all.messages.map((message) => message.text)).toEqual([
      '第一件事',
      '第一件做完了',
      '第二件事',
      '第二件做完了',
      '第三件事',
      '第三件失败了',
    ]);
    expect(all.openTodos).toEqual(['跑 CI', '发布']);

    // 撤销最后一个回合：它的消息、结局都不算；清单属于它前面的回合时照旧。
    const undone = analyzeSession([...events, event('turn.undone', { turnId: 't3' })]);
    expect(undone.turns).toBe(2);
    expect(undone.lastOutcome).toBe('completed');
    expect(undone.messages.map((message) => message.text)).not.toContain('第三件事');
    expect(undone.marker).toBe(
      events.find((e) => e.type === 'turn.finished' && String(e.payload.turnId) === 't2')?.seq,
    );
    // 重做把它带回来。
    expect(
      analyzeSession([
        ...events,
        event('turn.undone', { turnId: 't3' }),
        event('turn.redone', { turnId: 't3' }),
      ]).turns,
    ).toBe(3);
    // 撤回（rewind）的回合彻底不算，清单也不算。
    const rewound = analyzeSession([...events, event('turn.rewound', { turnId: 't3' })]);
    expect(rewound.turns).toBe(2);
    expect(rewound.messages).toHaveLength(4);
    const rewoundTodos = analyzeSession([...events, event('turn.rewound', { turnId: 't2' })]);
    expect(rewoundTodos.openTodos).toEqual([]);
  });

  it('没有回合：marker 与结局都是 undefined', () => {
    seq = 0;
    const result = analyzeSession([event('session.created', {})]);
    expect(result).toMatchObject({ turns: 0, marker: undefined, lastOutcome: undefined });
  });
});

describe('recapInput', () => {
  function analysisOf(...turns: Array<[string, string]>) {
    seq = 0;
    return analyzeSession(turns.flatMap(([user, answer], i) => turn(`t${i}`, user, answer)));
  }

  it('<conversation> 里是转义过的最近消息，<state> 里是最近一个回合的结局', () => {
    const input = recapInput(
      analysisOf(['改 <b> & "c"', '好的\n\n已经改了'], ['再看看', '没问题']),
    );
    expect(input).toBe(
      [
        '<conversation>',
        '<message role="user">改 &lt;b&gt; &amp; "c"</message>',
        '<message role="assistant">好的 已经改了</message>',
        '<message role="user">再看看</message>',
        '<message role="assistant">没问题</message>',
        '</conversation>',
        '<state>',
        'last_turn: completed',
        '</state>',
      ].join('\n'),
    );
  });

  it('清单里没做完的项进 <state>，最多 5 项', () => {
    seq = 0;
    const events = [
      ...turn('t1', '做事', '开工'),
      event('todo.updated', {
        turnId: 't1',
        toolCallId: 'p',
        items: Array.from({ length: 8 }, (_, i) => ({
          content: `步骤 ${i + 1}`,
          status: 'pending',
        })),
      }),
    ];
    const input = recapInput(analyzeSession(events));
    expect(input).toContain(
      'open_todos:\n- 步骤 1\n- 步骤 2\n- 步骤 3\n- 步骤 4\n- 步骤 5\n</state>',
    );
    expect(input).not.toContain('步骤 6');
  });

  it('用户消息留开头、助手消息留结尾，各自截断', () => {
    const long = (head: string, tail: string, n: number) => `${head}${'中'.repeat(n)}${tail}`;
    const input = recapInput(analysisOf([long('开头', '结尾', 1000), long('答头', '答尾', 1500)]));
    expect(input).toContain('<message role="user">开头');
    expect(input).not.toContain('结尾<');
    expect(input).toContain('…</message>');
    expect(input).toContain('<message role="assistant">…');
    expect(input).toContain('答尾</message>');
    expect(input).not.toContain('答头');
    const user = /<message role="user">(.*?)<\/message>/u.exec(input)?.[1] ?? '';
    const assistant = /<message role="assistant">(.*?)<\/message>/u.exec(input)?.[1] ?? '';
    expect(Array.from(user)).toHaveLength(RECAP_USER_CHARS + 1);
    expect(Array.from(assistant)).toHaveLength(RECAP_ASSISTANT_CHARS + 1);
  });

  it('最多 8 条消息；总长超过预算时从最早的开始丢，最新的一条总是留着', () => {
    const many = recapInput(
      analysisOf(...Array.from({ length: 10 }, (_, i): [string, string] => [`问${i}`, `答${i}`])),
    );
    expect(many.match(/<message /gu)).toHaveLength(RECAP_MAX_MESSAGES);
    expect(many).not.toContain('问0<');
    expect(many).toContain('答9');

    const fat = 'x'.repeat(RECAP_ASSISTANT_CHARS);
    const budget = recapInput(
      analysisOf(
        ...Array.from({ length: 6 }, (_, i): [string, string] => [`问${i}`, `${fat}${i}`]),
      ),
    );
    expect(Buffer.byteLength(budget, 'utf8')).toBeLessThanOrEqual(RECAP_INPUT_MAX_BYTES);
    expect(budget).toContain('x5<');
    expect(budget).not.toContain('问0');
    // 一条消息撑破预算也得留着。
    expect(recapInput(analysisOf(['问', '答'.repeat(10)])).match(/<message /gu)).toHaveLength(2);
  });
});

describe('splitSentences', () => {
  it('中文句末标点之后切，英文句号只在后面是空白或结尾时切（版本号、文件名里的点不切）', () => {
    expect(splitSentences('改好了。请验证？好！')).toEqual(['改好了。', '请验证？', '好！']);
    expect(splitSentences('Updated v1.2.3 and app.ts. Check it. Done')).toEqual([
      'Updated v1.2.3 and app.ts.',
      'Check it.',
      'Done',
    ]);
    expect(splitSentences('真的吗？！好吧... 然后呢')).toEqual(['真的吗？！', '好吧...', '然后呢']);
    expect(splitSentences('真的吗？！好吧...然后呢')).toEqual(['真的吗？！', '好吧...然后呢']);
    expect(splitSentences('')).toEqual([]);
  });
});

describe('parseRecap', () => {
  it('取 JSON 里的 recap；代码块、首尾引号、前缀、Markdown 记号都去掉', () => {
    expect(parseRecap('{"recap": "在补测试。请先跑一遍。"}')).toBe('在补测试。请先跑一遍。');
    expect(parseRecap('```json\n{"recap": "「在补测试。请先跑一遍。」"}\n```')).toBe(
      '在补测试。请先跑一遍。',
    );
    expect(parseRecap('{"recap": "摘要：**在补测试**。请先 `pnpm test`。"}')).toBe(
      '在补测试。请先 pnpm test。',
    );
    expect(parseRecap('{"recap": "Recap: Fixing login.\\n\\nNext, review the diff."}')).toBe(
      'Fixing login. Next, review the diff.',
    );
  });

  it('没有 JSON 时（网关路径）把整段输出当摘要；是坏掉的 JSON 或缺字段时算失败', () => {
    expect(parseRecap('回顾：在补测试，请先跑一遍。')).toBe('在补测试，请先跑一遍。');
    expect(parseRecap('"Fixing login. Review the diff."')).toBe('Fixing login. Review the diff.');
    expect(parseRecap('{"recap": ')).toBeUndefined();
    expect(parseRecap('{"title": "别的字段"}')).toBeUndefined();
    expect(parseRecap('{"recap": 3}')).toBeUndefined();
    expect(parseRecap('{"recap": "  "}')).toBeUndefined();
    expect(parseRecap('')).toBeUndefined();
  });

  it('最多三句、240 个字符：多的句子丢掉；一句就超长时硬截加省略号', () => {
    expect(parseRecap('{"recap": "一。二。三。四。五。"}')).toBe('一。二。三。');
    const sentence = (n: number) => `${'长'.repeat(100)}${n}。`;
    // 前两句 202 个字符，第三句放不下。
    expect(parseRecap(JSON.stringify({ recap: sentence(1) + sentence(2) + sentence(3) }))).toBe(
      sentence(1) + sentence(2),
    );
    const hard = parseRecap(JSON.stringify({ recap: '长'.repeat(500) })) ?? '';
    expect(Array.from(hard)).toHaveLength(RECAP_MAX_CHARS);
    expect(hard.endsWith('…')).toBe(true);
  });
});

describe('RecapCache', () => {
  const recap = (throughSeq: number) => ({ text: '摘要', generatedAt: TS, throughSeq });

  it('按位置去重：同一位置拿缓存，位置变了就没有；生成中的共用同一个 promise', async () => {
    const cache = new RecapCache();
    expect(cache.get('a', 5)).toBeUndefined();
    let resolve!: (value: ReturnType<typeof recap>) => void;
    const promise = new Promise<ReturnType<typeof recap>>((r) => (resolve = r));
    expect(cache.track('a', 5, promise)).toBe(promise);
    expect(cache.pending('a', 5)).toBe(promise);
    expect(cache.pending('a', 6)).toBeUndefined();
    resolve(recap(5));
    await promise;
    await Promise.resolve();
    expect(cache.pending('a', 5)).toBeUndefined();
    expect(cache.get('a', 5)).toEqual(recap(5));
    expect(cache.get('a', 6)).toBeUndefined();
    cache.forget('a');
    expect(cache.get('a', 5)).toBeUndefined();
  });

  it('失败的生成不进缓存，登记也清掉', async () => {
    const cache = new RecapCache();
    const failed = Promise.resolve(undefined);
    cache.track('a', 1, failed);
    await failed;
    await Promise.resolve();
    expect(cache.pending('a', 1)).toBeUndefined();
    expect(cache.get('a', 1)).toBeUndefined();
  });

  it(`最多留 ${RECAP_CACHE_SIZE} 个会话，先丢最早的`, async () => {
    const cache = new RecapCache();
    for (let i = 0; i <= RECAP_CACHE_SIZE; i += 1) {
      const promise = Promise.resolve(recap(i + 1));
      cache.track(`s${i}`, i + 1, promise);
      await promise;
      await Promise.resolve();
    }
    expect(cache.get('s0', 1)).toBeUndefined();
    expect(cache.get('s1', 2)).toBeDefined();
    expect(cache.get(`s${RECAP_CACHE_SIZE}`, RECAP_CACHE_SIZE + 1)).toBeDefined();
    cache.clear();
    expect(cache.get('s1', 2)).toBeUndefined();
  });
});
