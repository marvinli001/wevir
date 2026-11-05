import { type ChatMessage, projectTranscript } from '@wevir/client-sdk';
import type {
  ApprovalRequest,
  SessionId,
  TurnId,
  WevirEvent,
  WevirEventOf,
  WevirEventPayload,
  WevirEventType,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { currentAction, groupWork, type WorkEntry } from './tool-model';
import {
  adjoinsNotice,
  alwaysShown,
  blockSeqRange,
  continuesAgent,
  engineSources,
  filesAfterAnswer,
  finalAnswer,
  foldedParts,
  foldItems,
  foldTurn,
  groupTurns,
  handoffAfterLastTurn,
  isActiveTurn,
  isReportOnly,
  lastTurnId,
  messageIndexForSeq,
  turnHeaderText,
  turnStart,
  turnTail,
} from './turn-model';

const SES: SessionId = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN2: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQS';
const TURN3: TurnId = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQT';
const STREAM = 'stm_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
const APPROVAL = 'apr_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
const PENDING = 'pnd_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
const self = { clientId: 'cli_desktop', clientKind: 'desktop', deviceId: 'dev_x' } as const;

/** 按调用顺序分配 seq 的事件，每条隔一秒。 */
function session() {
  let seq = 0;
  const list: WevirEvent[] = [];
  const add = <T extends WevirEventType>(type: T, payload: WevirEventPayload<T>) => {
    seq += 1;
    list.push({
      seq,
      sessionId: SES,
      ts: new Date(Date.UTC(2026, 9, 14, 8, 0, seq)).toISOString(),
      type,
      source: 'host',
      payload,
    } as WevirEventOf<T>);
  };
  const turn = (turnId: TurnId = TURN) => {
    add('user.message', { turnId, content: [{ type: 'text', text: '改一下' }], sentBy: self });
    add('turn.started', { turnId });
    add('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
  };
  const say = (turnId: TurnId, text: string, kind: 'message' | 'thought' = 'message') =>
    add(kind === 'message' ? 'assistant.message' : 'assistant.thought', {
      turnId,
      messageId: `m${seq}`,
      text,
      replaces: [],
    });
  const run = (
    turnId: TurnId,
    id: string,
    display: WevirEventPayload<'tool.started'>['display'],
    input: unknown = {},
    /** null：不收尾（还在运行）。 */
    status: 'completed' | 'failed' | null = 'completed',
  ) => {
    add('tool.started', { turnId, toolCallId: id, toolName: display.kind, display, input });
    if (status) add('tool.finished', { turnId, toolCallId: id, status });
  };
  const finish = (
    turnId: TurnId,
    outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
  ) => {
    add('turn.finished', { turnId, outcome, durationMs: 151_000 });
    add('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
  };
  return { list, add, turn, say, run, finish, project: () => projectTranscript(list) };
}

function approval(toolCallId: string): ApprovalRequest {
  return {
    id: APPROVAL,
    sessionId: SES,
    turnId: TURN,
    toolCallId,
    options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow_once', category: 'allow' }],
    detail: null,
    status: 'pending',
    createdAt: '2026-10-14T08:00:10.000Z',
  };
}

/** 一个典型的回合：思考、读两个文件、搜索、说一句、改文件、跑命令（失败一次），最后回答。 */
function fullTurn(outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed') {
  const s = session();
  s.turn();
  s.say(TURN, '先看看结构', 'thought');
  s.run(TURN, 'r1', { kind: 'read', paths: ['src/a.ts'] });
  s.run(TURN, 'r2', { kind: 'read', paths: ['src/b.ts'] });
  s.run(TURN, 's1', { kind: 'search', query: 'TODO' });
  s.say(TURN, '我来改一下 a.ts。');
  s.run(
    TURN,
    'e1',
    { kind: 'edit', paths: ['src/a.ts'] },
    { old_string: 'a\nb', new_string: 'a\nc\nd' },
  );
  s.run(TURN, 'x1', { kind: 'shell', command: 'pnpm test' }, {}, 'failed');
  s.run(TURN, 'x2', { kind: 'shell', command: 'pnpm test' });
  s.say(TURN, '改好了，测试通过。');
  s.finish(TURN, outcome);
  return s;
}

const texts = (messages: readonly ChatMessage[]) =>
  messages.map((m) => m.parts.map((p) => (p.type === 'text' ? p.text : p.type)));

describe('groupTurns / turnStart', () => {
  it('同一回合的用户消息、插话与几段助手消息合成一块；系统消息单独一块', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'x1', { kind: 'shell', command: 'ls' });
    s.add('user.steered', {
      turnId: TURN,
      pendingId: PENDING,
      clientMessageId: 'c1',
      content: [{ type: 'text', text: '顺便跑测试' }],
      sentBy: self,
    });
    s.say(TURN, '好的。');
    s.finish(TURN, 'completed');
    s.add('session.read_only', { reason: 'engine_session_not_found', message: 'x' });
    s.turn(TURN2);
    const { messages } = s.project();
    const blocks = groupTurns(messages);
    expect(blocks.map((b) => [b.kind, b.kind === 'turn' ? b.messages.length : 1])).toEqual([
      ['turn', 4],
      ['message', 1],
      ['turn', 2],
    ]);
    // 分段渲染的起点落在回合中间时挪到回合开头。
    expect(turnStart(messages, 2)).toBe(0);
    expect(turnStart(messages, 4)).toBe(4);
    expect(turnStart(messages, 6)).toBe(5);
  });

  it('只说引擎会话已恢复的系统消息不进消息流', () => {
    const s = session();
    s.turn();
    s.say(TURN, '好的。');
    s.finish(TURN, 'completed');
    s.add('session.resumed', { engineVersion: 'rust-v0.165.0' });
    s.turn(TURN2);
    const { messages } = s.project();
    expect(messages.some((m) => m.role === 'system')).toBe(true);
    expect(groupTurns(messages).map((b) => b.kind)).toEqual(['turn', 'turn']);
  });

  it('isReportOnly：回合结束后才到的任务回报自成一块，别的系统消息与回合不算', () => {
    const TASK = 'tsk_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
    const CHILD = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS' as const;
    const s = session();
    s.turn();
    s.run(TURN, 'k1', { kind: 'unknown', summary: 'wevir_tasks/suggest_tasks' });
    s.add('tasks.suggested', {
      toolCallId: 'k1',
      turnId: TURN,
      tasks: [
        {
          id: TASK,
          title: '补测试',
          prompt: '补测试',
          toolCallId: 'k1',
          turnId: TURN,
          status: 'suggested',
        },
      ],
    });
    s.add('task.started', { taskId: TASK, sessionId: CHILD });
    s.say(TURN, '建议了一项后续任务。');
    s.finish(TURN, 'completed');
    s.add('task.reported', { taskId: TASK, sessionId: CHILD, outcome: 'completed' });
    s.add('session.read_only', { reason: 'engine_session_not_found', message: 'x' });
    const blocks = groupTurns(s.project().messages);
    expect(blocks.map((block) => [block.kind, isReportOnly(block)])).toEqual([
      ['turn', false],
      ['message', true],
      ['message', false],
    ]);
  });

  it('adjoinsNotice：提示行和紧跟在它后面的块挨着放，回合之间照常隔开', () => {
    const s = session();
    s.turn();
    s.say(TURN, '完成。');
    s.finish(TURN, 'completed');
    s.turn(TURN2);
    s.say(TURN2, '再来。');
    s.finish(TURN2, 'completed');
    s.add('session.read_only', { reason: 'engine_session_not_found', message: 'x' });
    s.add('session.resumed', {});
    s.turn(TURN3);
    s.say(TURN3, '继续。');
    s.finish(TURN3, 'completed');
    // 只读提示照常显示；随后的“已恢复”不进消息流。
    const blocks = groupTurns(s.project().messages);
    expect(blocks.map((block, index) => adjoinsNotice(block, blocks[index - 1]))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('continuesAgent', () => {
  it('开头是回报或额度恢复后的继续的回合接着上一个回合；用户自己发的与引用的第二意见不算', () => {
    const s = session();
    s.turn();
    s.say(TURN, '已开出子会话。');
    s.finish(TURN, 'completed');
    s.add('user.message', {
      turnId: TURN2,
      content: [{ type: 'text', text: '子会话做完了' }],
      sentBy: self,
      from: { sessionId: SES, kind: 'report' },
    });
    s.add('turn.started', { turnId: TURN2 });
    s.say(TURN2, '收到回报。');
    const blocks = groupTurns(s.project().messages);
    expect(blocks.map(continuesAgent)).toEqual([false, true]);

    const opinion = session();
    opinion.add('user.message', {
      turnId: TURN,
      content: [{ type: 'text', text: '看看这条意见' }],
      sentBy: self,
      from: {
        sessionId: SES,
        kind: 'report',
        opinion: { opinionId: 'opn_01JA2B3C4D5E6F7G8H9JKMNPQR' },
      },
    });
    opinion.add('turn.started', { turnId: TURN });
    expect(groupTurns(opinion.project().messages).map(continuesAgent)).toEqual([false]);
    const message = session();
    message.turn();
    message.say(TURN, '好。');
    message.finish(TURN, 'completed');
    message.add('user.message', {
      turnId: TURN2,
      content: [{ type: 'text', text: '帮我看看测试' }],
      sentBy: self,
      from: { sessionId: SES, kind: 'message' },
    });
    message.add('turn.started', { turnId: TURN2 });
    expect(groupTurns(message.project().messages).map(continuesAgent)).toEqual([false, true]);
  });
});

describe('lastTurnId（0.38.0）', () => {
  it('最后一条用户或助手消息所在的回合；后面的系统消息不算；撤回之后是之前那个', () => {
    const s = session();
    expect(lastTurnId(s.project())).toBeUndefined();
    s.turn();
    s.say(TURN, '一');
    s.finish(TURN, 'completed');
    s.turn(TURN2);
    s.say(TURN2, '二');
    s.finish(TURN2, 'completed');
    s.add('session.read_only', { reason: 'engine_session_not_found', message: 'x' });
    expect(lastTurnId(s.project())).toBe(TURN2);
    s.add('turn.rewound', { turnId: TURN2 });
    expect(lastTurnId(s.project())).toBe(TURN);
  });
});

describe('handoffAfterLastTurn（0.25.0）', () => {
  const handoff = (from: string, to: string) => ({
    from: { providerId: from, modelId: `${from}-m`, engineSessionId: `e-${from}` },
    to: { providerId: to, modelId: `${to}-m`, engineSessionId: `e-${to}` },
    resumed: false,
    strategy: 'full_thread_summary' as const,
    items: 0,
    omittedItems: 0,
  });

  it('最后一个回合之后的最早一次接力；之后又有回合时没有', () => {
    const s = session();
    s.turn();
    s.say(TURN, '一');
    s.finish(TURN, 'failed');
    expect(handoffAfterLastTurn(s.project())).toBeUndefined();
    s.add('session.handoff', handoff('a', 'b'));
    s.add('session.handoff', handoff('b', 'c'));
    expect(handoffAfterLastTurn(s.project())).toMatchObject({
      fromProviderId: 'a',
      fromModelId: 'a-m',
      providerId: 'b',
    });
    s.turn(TURN2);
    s.say(TURN2, '二');
    s.finish(TURN2, 'completed');
    expect(handoffAfterLastTurn(s.project())).toBeUndefined();
  });
});

describe('回合的引擎分段', () => {
  it('固定每回合的账号和模型；换模型沿用段，换账号及返回旧引擎各起新段', () => {
    const s = session();
    s.add('session.created', {
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      cwd: '/workspace',
      providerId: 'claude',
      modelId: 'sonnet',
    });
    const first = { segment: 0, providerId: 'claude', modelId: 'sonnet' };
    s.turn();
    s.say(TURN, '一');
    s.finish(TURN, 'completed');
    s.add('session.configured', { modelId: 'opus' });
    s.turn(TURN2);
    s.say(TURN2, '二');
    s.finish(TURN2, 'completed');
    const switchTo = (from: string, to: string, modelId: string, resumed = false) =>
      s.add('session.handoff', {
        from: { providerId: from, modelId: 'opus', engineSessionId: `e-${from}` },
        to: { providerId: to, modelId, engineSessionId: `e-${to}` },
        resumed,
        strategy: 'full_thread_summary',
        items: 0,
        omittedItems: 0,
      });
    switchTo('claude', 'claude-work', 'opus');
    const third = 'trn_third';
    s.add('turn.started', { turnId: third, command: { kind: 'compact' } });
    s.say(third, '三');
    s.add('user.steered', {
      turnId: third,
      pendingId: PENDING,
      content: [{ type: 'text', text: '继续' }],
      sentBy: self,
    });
    s.say(third, '继续');
    s.finish(third, 'completed');
    switchTo('claude-work', 'chatgpt', 'gpt');
    switchTo('chatgpt', 'claude', 'sonnet', true);
    s.turn('trn_return');
    const transcript = s.project();
    const turns = groupTurns(transcript.messages).filter((block) => block.kind === 'turn');
    expect(turns.map((block) => block.engine)).toEqual([
      first,
      { segment: 0, providerId: 'claude', modelId: 'opus' },
      { segment: 1, providerId: 'claude-work', modelId: 'opus' },
      { segment: 3, providerId: 'claude', modelId: 'sonnet' },
    ]);
    expect(
      turns[2]?.messages.every(
        (message) => message.role !== 'system' && message.engine === turns[2]?.engine,
      ),
    ).toBe(true);
    expect(transcript.engineSegments?.map((segment) => segment.providerId)).toEqual([
      'claude',
      'claude-work',
      'chatgpt',
      'claude',
    ]);
    expect(turns[0]?.engine).toEqual(first);
    const notices = transcript.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === 'notice');
    expect(
      notices.every(
        (part) =>
          (part.notice.kind === 'handoff' || part.notice.kind === 'configured') &&
          part.notice.at !== undefined,
      ),
    ).toBe(true);
  });

  it('单段不显示来源；多段按来源首次出现去重，保留首次切换点和已删除的来源', () => {
    const segments = ['claude', 'claude-work', 'chatgpt', 'claude', 'removed'].map(
      (providerId, segment) => ({
        segment,
        providerId,
        modelId: 'm',
        seq: segment * 10 + 1,
        startedAt: '2026-11-03T00:00:00.000Z',
      }),
    );
    const providers = [
      { id: 'claude', kind: 'claude' },
      { id: 'claude-work', kind: 'claude' },
      { id: 'chatgpt', kind: 'chatgpt' },
    ] as const;
    expect(engineSources(segments.slice(0, 1), providers)).toEqual([]);
    expect(
      engineSources(segments, providers).map((segment) => [segment.providerId, segment.seq]),
    ).toEqual([
      ['claude', 1],
      ['chatgpt', 21],
      ['removed', 41],
    ]);
  });
});

describe('alwaysShown', () => {
  it('生成的图片（0.118.0）收起的回合里也在，别的工具不在', () => {
    const tool = (kind: 'image' | 'shell') => ({
      type: 'tool' as const,
      key: `t:${kind}`,
      toolCallId: kind,
      toolName: kind,
      display: { kind },
      status: 'completed' as const,
      input: {},
      startedAt: '2026-10-23T00:00:00.000Z',
    });
    expect(alwaysShown(tool('image'))).toBe(true);
    expect(alwaysShown(tool('shell'))).toBe(false);
  });
});

describe('foldTurn', () => {
  it('正常完成：过程收起，只留最后的回答；文件改动只算成功的修改', () => {
    const transcript = fullTurn().project();
    const [user, assistant] = transcript.messages;
    const fold = foldTurn(transcript.messages, false, false);
    expect(fold).toMatchObject({
      finished: { outcome: 'completed', durationMs: 151_000 },
      hasProcess: true,
      showHeader: true,
      defaultFolded: true,
      changes: { files: 1, added: 2, removed: 1 },
    });
    expect(fold).not.toHaveProperty('issues');
    expect(turnHeaderText(fold.finished ?? { outcome: 'completed', durationMs: 0 })).toBe(
      '已处理 2 分 31 秒',
    );
    expect(user && texts([{ ...user, parts: foldedParts(user, fold) }])).toEqual([['改一下']]);
    expect(
      assistant && foldedParts(assistant, fold).map((p) => p.type === 'text' && p.text),
    ).toEqual(['改好了，测试通过。']);
    // 展开后：思考与三次读取 / 搜索一组，说的话断开，修改与两次命令一组，再是回答。
    const items = groupWork(assistant?.parts ?? []);
    expect(items.map((item) => (item.kind === 'work' ? item.entries.length : item.kind))).toEqual([
      4,
      'part',
      3,
      'part',
    ]);
    // 逐项标好收起时留不留：只有回答留下；各项与整条消息的分组一致。
    const folded = assistant ? foldItems(assistant.id, assistant.parts, fold) : [];
    expect(folded.map(({ item, kept }) => [kept, item.kind])).toEqual([
      [false, 'work'],
      [false, 'part'],
      [false, 'work'],
      [true, 'part'],
    ]);
    expect(folded.map(({ item }) => item)).toEqual(items);
  });

  it('turnTail：刚更新完清单时最后一项仍是工作组（清单画在回合末尾，不另起“正在思考”）', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'w1', { kind: 'plan' }, {}, null);
    s.add('todo.updated', {
      turnId: TURN,
      toolCallId: 'w1',
      items: [{ content: '列出本周提交', status: 'in_progress' }],
    });
    const messages = s.project().messages;
    expect(messages.at(-1)?.parts.at(-1)?.type).toBe('todo');
    expect(turnTail(messages.at(-1), false)?.kind).toBe('work');
    s.say(TURN, '好的。');
    expect(turnTail(s.project().messages.at(-1), false)).toMatchObject({
      kind: 'part',
      part: { type: 'text' },
    });
    expect(turnTail(messages[0], false)).toBeUndefined();
  });

  it('finalAnswer：只取收起时留下的最后一段正文，不带中途说的话', () => {
    const { messages } = fullTurn().project();
    expect(finalAnswer(messages, foldTurn(messages, false, false))).toBe('改好了，测试通过。');
    const s = session();
    s.turn();
    s.run(TURN, 'x1', { kind: 'shell', command: 'ls' });
    s.finish(TURN, 'cancelled');
    const quiet = s.project().messages;
    expect(finalAnswer(quiet, foldTurn(quiet, false, false))).toBe('');
  });

  it('只有正文的回合：没有那一行，也不收起', () => {
    const s = session();
    s.turn();
    s.say(TURN, '你好！');
    s.finish(TURN, 'completed');
    const fold = foldTurn(s.project().messages, false, false);
    expect(fold).toMatchObject({ hasProcess: false, showHeader: false, defaultFolded: false });
    expect(fold.changes.files).toBe(0);
  });

  it('出错、被停止、被中断的回合不自动收起，那一行写结果与用时；只有正文也有那一行', () => {
    for (const [outcome, header] of [
      ['failed', '出错 · 2 分 31 秒'],
      ['cancelled', '已停止 · 2 分 31 秒'],
      ['interrupted', '已中断 · 2 分 31 秒'],
    ] as const) {
      const fold = foldTurn(fullTurn(outcome).project().messages, false, false);
      expect(fold).toMatchObject({ showHeader: true, defaultFolded: false });
      expect(fold.finished && turnHeaderText(fold.finished)).toBe(header);
    }
    const s = session();
    s.turn();
    s.say(TURN, '说到一半');
    s.finish(TURN, 'cancelled');
    expect(foldTurn(s.project().messages, false, false)).toMatchObject({
      hasProcess: false,
      showHeader: true,
      defaultFolded: false,
    });
  });

  it('错误部件与插话收起时照样显示；回合结束时没收尾的工具算状态未知', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'x1', { kind: 'shell', command: 'sleep 9' }, {}, null);
    s.add('engine.error', {
      turnId: TURN,
      category: 'provider',
      message: '上游断开',
      fatal: false,
    });
    s.add('user.steered', {
      turnId: TURN,
      pendingId: PENDING,
      clientMessageId: 'c1',
      content: [{ type: 'text', text: '先别跑了' }],
      sentBy: self,
    });
    s.run(TURN, 'r1', { kind: 'read', paths: ['a.ts'] });
    s.say(TURN, '好，停下了。');
    s.finish(TURN, 'completed');
    const { messages } = s.project();
    const fold = foldTurn(messages, false, false);
    expect(
      texts(messages.map((m) => ({ ...m, parts: foldedParts(m, fold) }) as ChatMessage)),
    ).toEqual([['改一下'], ['error'], ['先别跑了'], ['好，停下了。']]);
  });

  it('建议的任务（U23）：卡片在收起的回合里照样显示', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'k1', { kind: 'unknown', summary: 'wevir_tasks/suggest_tasks' });
    s.add('tasks.suggested', {
      toolCallId: 'k1',
      turnId: TURN,
      tasks: [
        {
          id: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPQR',
          title: '补测试',
          prompt: '补测试',
          toolCallId: 'k1',
          turnId: TURN,
          status: 'suggested',
        },
      ],
    });
    s.say(TURN, '建议了一项后续任务。');
    s.finish(TURN, 'completed');
    const messages = s.project().messages;
    const fold = foldTurn(messages, false, false);
    expect(fold.defaultFolded).toBe(true);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant && foldedParts(assistant, fold).map((p) => p.type)).toEqual(['tasks', 'text']);
    expect(
      assistant &&
        foldItems(assistant.id, assistant.parts, fold).map(({ item, kept }) => [
          kept,
          item.kind === 'part' ? item.part.type : item.kind,
        ]),
    ).toEqual([
      [false, 'work'],
      [true, 'tasks'],
      [true, 'text'],
    ]);
  });

  it('压缩上下文（0.24.0）：命令回合没有那一行；自动压缩在收起的回合里照样显示，不算过程', () => {
    const s = session();
    s.add('turn.started', { turnId: TURN, command: { kind: 'compact' } });
    s.add('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
    s.add('context.compacting', { turnId: TURN, compactionId: 'c1', trigger: 'manual' });
    s.add('context.compacted', { turnId: TURN, compactionId: 'c1', trigger: 'manual' });
    s.finish(TURN, 'completed');
    let messages = s.project().messages;
    expect(messages[0]).toMatchObject({ role: 'user', command: { kind: 'compact' } });
    let fold = foldTurn(messages, false, false);
    expect(fold).toMatchObject({ showHeader: false, hasProcess: false });

    s.turn(TURN2);
    s.run(TURN2, 'r1', { kind: 'read', paths: ['src/a.ts'] });
    s.add('context.compacted', { turnId: TURN2, compactionId: 'c2', trigger: 'auto' });
    s.say(TURN2, '好了。');
    s.finish(TURN2, 'completed');
    messages = s.project().messages.filter((m) => m.role !== 'system' && m.turnId === TURN2);
    fold = foldTurn(messages, false, false);
    expect(fold.defaultFolded).toBe(true);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant && foldedParts(assistant, fold).map((p) => p.type)).toEqual([
      'compaction',
      'text',
    ]);
  });

  it('审查发现（0.83.0）：在收起的回合里照样显示，不算过程', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'r1', { kind: 'read', paths: ['src/a.ts'] });
    s.add('review.findings', {
      origin: 'tool',
      findings: [{ title: '空指针', body: '', path: 'src/a.ts', startLine: 3 }],
      turnId: TURN,
    });
    s.say(TURN, '报了一条。');
    s.finish(TURN, 'completed');
    const messages = s.project().messages;
    const fold = foldTurn(messages, false, false);
    expect(fold.defaultFolded).toBe(true);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant && foldedParts(assistant, fold).map((p) => p.type)).toEqual([
      'findings',
      'text',
    ]);

    const review = session();
    review.turn();
    review.add('review.findings', { origin: 'review', findings: [], turnId: TURN });
    review.say(TURN, '没发现问题。');
    review.finish(TURN, 'completed');
    expect(foldTurn(review.project().messages, false, false)).toMatchObject({
      hasProcess: false,
      showHeader: false,
    });
  });

  it('流式进行到一半：没有那一行；正在运行的工具是当前动作，增量里的思考是“正在思考”', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'r1', { kind: 'read', paths: ['a.ts'] });
    s.run(TURN, 'x1', { kind: 'shell', command: 'pnpm test' }, {}, null);
    let transcript = s.project();
    expect(isActiveTurn(TURN, transcript)).toBe(true);
    let fold = foldTurn(transcript.messages, false, true);
    expect(fold).toMatchObject({ showHeader: false, defaultFolded: false });
    expect(fold.startedAt).toBe('2026-10-14T08:00:02.000Z');
    const work = (messages: readonly ChatMessage[]) => {
      const item = groupWork(messages.at(-1)?.parts ?? []).at(-1);
      return item?.kind === 'work' ? item.entries : ([] as WorkEntry[]);
    };
    expect(currentAction(work(transcript.messages))).toEqual({
      text: '正在运行 pnpm test',
      tone: 'running',
    });
    s.add('tool.finished', { turnId: TURN, toolCallId: 'x1', status: 'completed' });
    s.add('assistant.delta', {
      turnId: TURN,
      streamId: STREAM,
      blockIndex: 0,
      kind: 'reasoning',
      text: '测试过了，',
    });
    transcript = s.project();
    fold = foldTurn(transcript.messages, false, true);
    expect(currentAction(work(transcript.messages))).toEqual({ text: '正在思考', tone: 'running' });
  });

  it('审批中：工具等待审批，当前动作写“等待审批：…”；会话不在进行时不算进行中的回合', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'x1', { kind: 'shell', command: 'touch ~/x.txt' }, {}, null);
    s.add('approval.requested', { approval: approval('x1') });
    s.add('session.state_changed', {
      from: 'running',
      to: 'awaiting_approval',
      reason: 'approval_requested',
    });
    const transcript = s.project();
    expect(isActiveTurn(TURN, transcript)).toBe(true);
    const item = groupWork(transcript.messages.at(-1)?.parts ?? []).at(-1);
    expect(item?.kind === 'work' && currentAction(item.entries)).toEqual({
      text: '等待审批：运行 touch ~/x.txt',
      tone: 'awaiting',
    });
    expect(isActiveTurn(TURN, { ...transcript, state: 'error' })).toBe(false);
  });

  it('派出过子会话时 collab 调用不算过程', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'c1', { kind: 'sub_agent', summary: 'wait' });
    s.say(TURN, '子 agent 做完了。');
    s.finish(TURN, 'completed');
    const { messages } = s.project();
    expect(foldTurn(messages, true, false)).toMatchObject({ hasProcess: false, showHeader: false });
    expect(foldTurn(messages, false, false)).toMatchObject({ hasProcess: true, showHeader: true });
  });

  it('交给用户的文件（0.40.0）：回合结束后排到回答后面，收起时和回答同一段；进行中不挪', () => {
    const s = session();
    s.turn();
    s.run(TURN, 'w1', { kind: 'shell', command: 'pandoc brief.md' });
    s.add('file.shared', {
      turnId: TURN,
      files: [{ path: 'brief.md', name: 'brief.md', size: 14_200 }],
    });
    s.say(TURN, '写好了。');
    const types = (messages: readonly ChatMessage[], turnActive: boolean) => {
      const fold = foldTurn(messages, false, turnActive);
      const assistant = messages.find((m) => m.role === 'assistant');
      if (!assistant) return [];
      return filesAfterAnswer(assistant.id, assistant.parts, fold).map((p) => p.type);
    };
    expect(types(s.project().messages, true)).toEqual(['tool', 'files', 'text']);

    s.finish(TURN, 'completed');
    const messages = s.project().messages;
    expect(types(messages, false)).toEqual(['tool', 'text', 'files']);
    const fold = foldTurn(messages, false, false);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(
      assistant &&
        foldItems(assistant.id, filesAfterAnswer(assistant.id, assistant.parts, fold), fold).map(
          ({ item, kept }) => [kept, item.kind === 'part' ? item.part.type : item.kind],
        ),
    ).toEqual([
      [false, 'work'],
      [true, 'text'],
      [true, 'files'],
    ]);
  });
});

describe('按 seq 找位置', () => {
  const message = (id: string, turnId: TurnId, seqRange: [number, number]) =>
    ({ id, role: 'assistant', turnId, parts: [], seqRange }) as unknown as ChatMessage;
  const messages = [
    message('a', TURN, [1, 4]),
    message('b', TURN, [5, 9]),
    message('c', TURN2, [12, 20]),
  ];

  it('包含 seq 的那条；落在空隙里取之前最近的一条；比第一条还早时 -1', () => {
    expect(messageIndexForSeq(messages, 6)).toBe(1);
    expect(messageIndexForSeq(messages, 12)).toBe(2);
    expect(messageIndexForSeq(messages, 10)).toBe(1);
    expect(messageIndexForSeq(messages, 99)).toBe(2);
    expect(messageIndexForSeq([message('x', TURN, [3, 4])], 1)).toBe(-1);
  });

  it('一块的范围是它所有消息的并集', () => {
    const [first, second] = groupTurns(messages);
    expect(first && blockSeqRange(first)).toEqual([1, 9]);
    expect(second && blockSeqRange(second)).toEqual([12, 20]);
  });
  it.each(['session.handoff', 'session.configured'] as const)(
    '额度继续更新旧卡片后，%s 的起点仍定位到切换消息',
    (type) => {
      const s = session();
      s.add('session.created', {
        workspaceId: 'ws_1',
        cwd: '/w',
        providerId: 'original',
        modelId: 'm',
      });
      s.turn();
      s.add('engine.error', {
        category: 'provider',
        message: 'quota',
        fatal: false,
        turnId: TURN,
        usageLimit: {},
      });
      s.finish(TURN, 'failed');
      if (type === 'session.configured')
        s.add(type, {
          modelId: 'other',
          reason: 'usage_limit',
          failover: { originTurnId: TURN, attempt: 1 },
        });
      else
        s.add(type, {
          from: { providerId: 'original', modelId: 'm', engineSessionId: 'a' },
          to: { providerId: 'backup', modelId: 'other', engineSessionId: 'b' },
          reason: 'usage_limit',
          failover: { originTurnId: TURN, attempt: 1 },
          resumed: false,
          strategy: 'full_thread_summary',
          items: 0,
          omittedItems: 0,
        });
      const seq = s.list.length;
      s.add('user.message', {
        turnId: TURN2,
        content: [{ type: 'text', text: 'continue' }],
        sentBy: self,
        from: { kind: 'report', sessionId: SES, usageLimit: { turnId: TURN } },
      });
      const messages = s.project().messages;
      const marker = messages.findIndex((message) => message.role === 'system');
      const previous = messages.find((message) => message.role === 'assistant');
      expect(previous?.seqRange[1]).toBeGreaterThan(seq);
      expect(messageIndexForSeq(messages, seq)).toBe(marker);
      expect(messageIndexForSeq(messages, seq + 1)).toBe(messages.length - 1);
    },
  );
});

describe('钩子结果的执行过程', () => {
  it('与思考和工具合组，正常回合默认折叠；被拦下的回合保留可展开的过程', () => {
    for (const outcome of ['completed', 'cancelled'] as const) {
      const s = session();
      s.turn();
      s.add('hook.outcome', {
        turnId: TURN,
        event: 'UserPromptSubmit',
        action: 'context',
        reason: 'Context',
      });
      if (outcome === 'completed') s.say(TURN, 'Answer');
      s.finish(TURN, outcome);
      const message = s.project().messages.find((entry) => entry.role === 'assistant');
      expect(message).toBeDefined();
      if (!message) continue;
      const fold = foldTurn([message], false, false);
      expect(fold.hasProcess).toBe(true);
      expect(fold.defaultFolded).toBe(outcome === 'completed');
      expect(foldedParts(message, fold).some((part) => part.type === 'hook')).toBe(false);
      expect(groupWork(message.parts)[0]).toMatchObject({
        kind: 'work',
        entries: [{ type: 'hook' }],
      });
    }
  });
});
