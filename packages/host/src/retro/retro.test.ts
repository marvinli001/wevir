import type { CodeState, SessionId, VerificationRun, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS } from '../secret-patterns.js';
import { buildRetro, type RetroLive } from './build.js';
import { emptyRetroState, foldRetro, parseRetroState } from './fold.js';
import { retroMarkdown } from './markdown.js';
import { redactRetro } from './redact.js';
import {
  loadRetroInstructions,
  parseRetroSummary,
  retroIds,
  retroSummaryInput,
} from './summary.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const OTHER = 'ses_01JA2B3C4D5E6F7G8H9JKMNPR1' as SessionId;
const T0 = '2026-10-20T00:00:00.000Z';
const T1 = '2026-10-20T01:00:00.000Z';
const identity = { deviceId: 'dev-1', clientId: 'desk-1', clientKind: 'desktop' } as const;
const GIT_A: CodeState = { kind: 'git', head: 'a'.repeat(40), tree: 'b'.repeat(40) };
const GIT_B: CodeState = { kind: 'git', head: 'e'.repeat(40), tree: 'c'.repeat(40) };

/** 事件序列的生成器：`seq` 自增。 */
function stream(start = 0, ts = T1) {
  let seq = start;
  const events: WevirEvent[] = [];
  const push = (type: string, payload: unknown, at = ts) => {
    seq += 1;
    const event = { seq, sessionId: SESSION, ts: at, type, source: 'host', payload } as WevirEvent;
    events.push(event);
    return event;
  };
  const user = (turnId: string, text: string) =>
    push('user.message', { turnId, content: [{ type: 'text', text }], sentBy: identity });
  const started = (turnId: string) => push('turn.started', { turnId });
  const finished = (turnId: string, outcome = 'completed') =>
    push('turn.finished', { turnId, outcome, durationMs: 10 });
  const edit = (turnId: string, path: string, id = `edit-${seq}`) =>
    push('tool.started', {
      turnId,
      toolCallId: id,
      toolName: 'apply_patch',
      display: { kind: 'edit', paths: [path] },
    });
  const shell = (turnId: string, command: string, status = 'completed') => {
    const id = `sh-${seq}`;
    push('tool.started', {
      turnId,
      toolCallId: id,
      toolName: 'shell',
      display: { kind: 'shell', command },
    });
    push('tool.finished', { turnId, toolCallId: id, status });
  };
  const assistant = (turnId: string, text: string) =>
    push('assistant.message', { turnId, messageId: `m-${seq}`, text, replaces: [] });
  const run = (patch: Partial<VerificationRun>) =>
    push('verification.updated', {
      run: {
        id: 'vrn_01JA2B3C4D5E6F7G8H9JKMNPQR',
        roundId: 'vrd_01JA2B3C4D5E6F7G8H9JKMNPQR',
        checkId: 'chk_01JA2B3C4D5E6F7G8H9JKMNPQR',
        checkRevision: 1,
        name: 'test',
        command: 'pnpm test',
        cwd: '',
        kind: 'test',
        trigger: 'manual',
        status: 'passed',
        queuedAt: ts,
        ...patch,
      },
    });
  return { events, push, user, started, finished, edit, shell, assistant, run };
}

function created(s: ReturnType<typeof stream>, extra: Record<string, unknown> = {}) {
  s.push(
    'session.created',
    {
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      cwd: '/repo',
      providerId: 'p',
      modelId: 'm',
      ...extra,
    },
    T0,
  );
}

const live = (patch: Partial<RetroLive> = {}): RetroLive => ({
  checkedAt: T1,
  repo: true,
  session: (id) => (id === SESSION ? { title: 'self' } : undefined),
  memories: new Set(),
  review: [],
  uncommitted: 0,
  upstream: true,
  ahead: 0,
  commits: [],
  checkpoints: new Map(),
  ...patch,
});

function retroOf(events: readonly WevirEvent[], liveFacts: RetroLive = live()) {
  const state = foldRetro(emptyRetroState(), events);
  return buildRetro({
    sessionId: SESSION,
    cwd: '/repo',
    state,
    live: liveFacts,
    builtAt: T1,
    build: 'full',
  });
}

describe('任务回顾：证据语义', () => {
  it('验证通过之后又改了文件：标“对应旧版本”，下一步是重跑', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '修好温度换算');
    s.started('trn_1');
    s.edit('trn_1', 'src/convert.ts');
    s.finished('trn_1');
    s.run({ status: 'passed', codeState: GIT_A, turnId: 'trn_1' as never });
    s.user('trn_2', '再加开尔文');
    s.started('trn_2');
    s.edit('trn_2', '/repo/src/convert.ts');
    s.finished('trn_2');

    // git：此刻的代码状态与记录不同。
    const git = retroOf(s.events, live({ codeState: GIT_B }));
    expect(git.verification.checks).toHaveLength(1);
    expect(git.verification.checks[0]).toMatchObject({ status: 'passed', evidence: 'outdated' });
    expect(git.delivery.checks).toBe('outdated');
    expect(git.next.map((n) => n.kind)).toContain('rerun_check');
    expect(git.changes.files).toEqual([
      expect.objectContaining({ path: 'src/convert.ts', turnIds: ['trn_1', 'trn_2'] }),
    ]);

    // 同一个代码状态：是当前版本。
    const same = retroOf(s.events, live({ codeState: GIT_A }));
    expect(same.verification.checks[0]?.evidence).toBe('current');
    expect(same.delivery.checks).toBe('passed');

    // 非 Git：比不出代码状态，看之后有没有改了文件的回合。
    const plain = retroOf(
      s.events,
      live({ repo: false, codeState: { kind: 'none', reason: 'not_git' } }),
    );
    expect(plain.verification.checks[0]?.evidence).toBe('outdated');
    const before = s.events.filter((event) => event.seq <= 7);
    expect(retroOf(before, live({ repo: false })).verification.checks[0]?.evidence).toBe('unbound');
  });

  it('Agent 说测试都通过了、命令也跑完了，但没有验证记录：未验证', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '修 bug 并跑测试');
    s.started('trn_1');
    s.edit('trn_1', 'src/a.ts');
    s.shell('trn_1', 'pnpm test');
    s.assistant('trn_1', '改好了，测试都通过了。');
    s.finished('trn_1');
    const retro = retroOf(s.events, live({ codeState: GIT_A }));
    expect(retro.verification.recorded).toBe(false);
    expect(retro.verification.checks).toEqual([]);
    expect(retro.delivery.checks).toBe('unverified');
    expect(retro.verification.commands).toEqual([
      expect.objectContaining({ text: 'pnpm test', status: 'completed' }),
    ]);
    expect(retro.next.map((n) => n.kind)).toContain('run_checks');
    expect(JSON.stringify(retro)).not.toContain('"passed"');
    expect(retroMarkdown(retro)).toContain('Unverified: no verification records.');
    expect(retroMarkdown(retro)).toMatch(
      /- \[run_checks\] Code changed with no verification records: run the relevant checks \(/,
    );
  });

  it('清单标了 completed，但验证失败：完成项只是登记，交付状态是失败', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '实现导出');
    s.started('trn_1');
    s.push('todo.updated', {
      turnId: 'trn_1',
      toolCallId: 'todo-1',
      items: [
        { content: '实现导出', status: 'completed' },
        { content: '补文档', status: 'pending' },
        { content: '放弃的', status: 'cancelled' },
      ],
    });
    s.finished('trn_1');
    s.run({ status: 'failed', reason: 'exit_code', exitCode: 1, codeState: GIT_A });
    s.push('acceptance.changed', { acceptance: { status: 'failed', updatedAt: T1 } });
    const retro = retroOf(s.events, live({ codeState: GIT_A }));
    expect(retro.done).toEqual([
      expect.objectContaining({ text: '实现导出', origin: 'todo', status: 'completed' }),
    ]);
    expect(retro.open.map((item) => item.text)).toEqual(['补文档']);
    expect(retro.verification.checks[0]).toMatchObject({ status: 'failed', reason: 'exit_code' });
    expect(retro.verification.checks[0]?.evidence).toBeUndefined();
    expect(retro.verification.acceptance).toBe('failed');
    expect(retro.delivery.checks).toBe('failed');
    expect(retro.next[0]).toMatchObject({ kind: 'fix_check' });
  });

  it('撤销且没重做的回合不出现；重做后回来', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '第一件事');
    s.started('trn_1');
    s.finished('trn_1');
    s.user('trn_2', '秘密的第二件事');
    s.started('trn_2');
    s.edit('trn_2', 'src/hidden.ts');
    s.shell('trn_2', 'rm -rf build');
    s.push('todo.updated', {
      turnId: 'trn_2',
      toolCallId: 'todo-2',
      items: [{ content: '隐藏的项', status: 'completed' }],
    });
    s.finished('trn_2');
    s.run({ status: 'passed', codeState: GIT_A, turnId: 'trn_2' as never });
    const undone = s.push('turn.undone', { turnId: 'trn_2' });
    const retro = retroOf(s.events, live({ codeState: GIT_A }));
    const text = JSON.stringify(retro);
    for (const hidden of ['秘密的第二件事', 'src/hidden.ts', 'rm -rf build', '隐藏的项']) {
      expect(text).not.toContain(hidden);
    }
    expect(retro.turns.map((turn) => turn.turnId)).toEqual(['trn_1']);
    expect(retro.hiddenTurns).toBe(1);
    expect(retro.verification.recorded).toBe(false);
    expect(retro.decisions).toEqual([
      expect.objectContaining({
        kind: 'undone',
        text: '',
        ref: { kind: 'event', seq: undone.seq },
      }),
    ]);

    s.push('turn.redone', { turnId: 'trn_2' });
    const redone = retroOf(s.events, live({ codeState: GIT_A }));
    expect(redone.turns.map((turn) => turn.turnId)).toEqual(['trn_1', 'trn_2']);
    expect(redone.hiddenTurns).toBe(0);
    expect(redone.verification.checks).toHaveLength(1);
  });

  it('章节：回合归到它结束前最后开始的一章；撤销、撤回的回合里标的不列；Markdown 与摘要输入都有', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '先看看代码');
    s.started('trn_1');
    s.finished('trn_1');
    s.user('trn_2', '开始实现');
    s.started('trn_2');
    const impl = s.push('chapter.marked', {
      title: '实现',
      summary: '改换算函数',
      turnId: 'trn_2',
    });
    s.edit('trn_2', 'src/convert.ts');
    s.finished('trn_2');
    s.user('trn_3', '再改一处');
    s.started('trn_3');
    s.finished('trn_3');
    s.user('trn_4', '跑测试');
    s.started('trn_4');
    s.push('chapter.marked', { title: '验证', turnId: 'trn_4' });
    s.finished('trn_4');
    s.push('turn.undone', { turnId: 'trn_4' });
    s.user('trn_5', '换个方向');
    s.started('trn_5');
    s.push('chapter.marked', { title: '撤回的章', turnId: 'trn_5' });
    s.finished('trn_5');
    s.push('turn.rewound', { turnId: 'trn_5' });

    const retro = retroOf(s.events);
    expect(retro.chapters).toEqual([
      {
        id: `h${impl.seq}`,
        text: '实现',
        summary: '改换算函数',
        ref: { kind: 'event', seq: impl.seq, turnId: 'trn_2' },
        turns: 2,
        at: T1,
      },
    ]);
    expect(retro.turns.map((turn) => [turn.turnId, turn.chapter])).toEqual([
      ['trn_1', undefined],
      ['trn_2', `h${impl.seq}`],
      ['trn_3', `h${impl.seq}`],
    ]);
    expect(retroMarkdown(retro)).toContain(
      `## Chapters\n- 实现: 改换算函数 (2 turns) (h${impl.seq})`,
    );
    expect(retroSummaryInput(retro)).toContain(
      `[h${impl.seq}] chapter (2 turns): 实现: 改换算函数`,
    );
    expect(retroIds(retro).has(`h${impl.seq}`)).toBe(true);

    s.push('turn.redone', { turnId: 'trn_4' });
    expect(retroOf(s.events).chapters?.map((chapter) => [chapter.text, chapter.turns])).toEqual([
      ['实现', 2],
      ['验证', 1],
    ]);
  });

  it('撤回的回合整个去掉', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '要撤回的');
    s.started('trn_1');
    s.finished('trn_1');
    s.push('turn.rewound', { turnId: 'trn_1' });
    const retro = retroOf(s.events);
    expect(retro.turns).toEqual([]);
    expect(retro.goal.recorded).toBe(false);
    expect(JSON.stringify(retro)).not.toContain('要撤回的');
    expect(retro.decisions.map((d) => d.kind)).toEqual(['rewound']);
  });

  it('被删除的来源显示“来源已删除”：被分的会话、开出的会话、笔记、回合快照', () => {
    const s = stream();
    created(s, { forkedFrom: { sessionId: OTHER, turnId: 'trn_0' } });
    s.user('trn_1', '接着做');
    s.started('trn_1');
    s.edit('trn_1', 'src/a.ts');
    s.push('tool.started', {
      turnId: 'trn_1',
      toolCallId: 'mem-1',
      toolName: 'mcp__wevir__wevir_memory_save',
      display: { kind: 'other' },
      input: {
        scope: 'project',
        name: 'gone-note',
        type: 'project',
        description: 'd',
        content: 'c',
      },
    });
    s.push('tool.started', {
      turnId: 'trn_1',
      toolCallId: 'mem-2',
      toolName: 'wevir_memory_save',
      display: { kind: 'other' },
      input: {
        server: 'wevir',
        tool: 'wevir_memory_save',
        args: { scope: 'global', name: 'kept-note' },
      },
    });
    s.push('task.started', { taskId: 'tsk_01JA2B3C4D5E6F7G8H9JKMNPQR', sessionId: OTHER });
    s.finished('trn_1');
    const retro = retroOf(
      s.events,
      live({
        session: () => undefined,
        memories: new Set(['global:kept-note']),
        checkpoints: new Map(),
        checkpointsDropped: true,
      }),
    );
    expect(retro.sessions).toEqual([
      expect.objectContaining({ sessionId: OTHER, relation: 'forked_from', source: 'deleted' }),
    ]);
    expect(retro.memories.map((m) => [m.name, m.source])).toEqual([
      ['gone-note', 'deleted'],
      ['kept-note', 'available'],
    ]);
    expect(retro.turns[0]?.diff).toBe('deleted');
    expect(retro.changes.files[0]?.diff).toBe('deleted');
    expect(retroMarkdown(retro)).toContain('source deleted');
  });

  it('分支：抄来的历史标“分支前”，之后的不标', () => {
    const s = stream();
    created(s, { forkedFrom: { sessionId: OTHER, turnId: 'trn_0' } });
    // 抄来的事件保留原来的时刻（早于新会话的创建）。
    s.push(
      'user.message',
      { turnId: 'trn_0', content: [{ type: 'text', text: '原来的请求' }], sentBy: identity },
      '2026-10-19T00:00:00.000Z',
    );
    s.push('turn.started', { turnId: 'trn_0' }, '2026-10-19T00:00:00.000Z');
    s.push(
      'turn.finished',
      { turnId: 'trn_0', outcome: 'completed', durationMs: 1 },
      '2026-10-19T00:00:01.000Z',
    );
    s.user('trn_1', '分支里的新要求');
    s.started('trn_1');
    s.finished('trn_1');
    const retro = retroOf(s.events);
    expect(retro.goal.request).toMatchObject({ text: '原来的请求', inherited: true });
    expect(retro.turns.map((turn) => [turn.turnId, turn.inherited ?? false])).toEqual([
      ['trn_0', true],
      ['trn_1', false],
    ]);
    expect(retro.decisions).toEqual([
      expect.objectContaining({ kind: 'instruction', text: '分支里的新要求' }),
    ]);
  });

  it('关键决定：后续指示、插话、回答、拒绝、停止；转来的消息不算', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '起始请求');
    s.started('trn_1');
    s.push('question.requested', {
      question: {
        id: 'qst_1',
        sessionId: SESSION,
        turnId: 'trn_1',
        questions: [{ id: 'q', question: '用哪种缓存？', options: [] }],
        status: 'pending',
        createdAt: T1,
      },
    });
    s.push('question.resolved', {
      questionId: 'qst_1',
      status: 'answered',
      resolution: { reason: 'user', answers: { q: { answers: ['Redis'] } }, answeredBy: identity },
    });
    s.push('approval.requested', {
      approval: {
        id: 'apr_1',
        sessionId: SESSION,
        turnId: 'trn_1',
        toolCallId: 'x',
        options: [{ optionId: 'no', label: 'No', kind: 'reject_once', category: 'reject' }],
        detail: { toolName: 'shell', display: { kind: 'shell', command: 'git push --force' } },
        status: 'pending',
        createdAt: T1,
      },
    });
    s.push('approval.resolved', {
      approvalId: 'apr_1',
      status: 'denied',
      resolution: { reason: 'user', optionId: 'no', decidedBy: identity },
    });
    s.push('user.steered', {
      turnId: 'trn_1',
      pendingId: 'pnd_1',
      content: [{ type: 'text', text: '别改公共接口' }],
      sentBy: identity,
    });
    s.finished('trn_1', 'cancelled');
    s.push('user.message', {
      turnId: 'trn_2',
      content: [{ type: 'text', text: '别的会话转来的' }],
      sentBy: identity,
      from: { sessionId: OTHER, kind: 'report' },
    });
    s.started('trn_2');
    s.finished('trn_2');
    s.user('trn_3', '换成 Redis 再试');
    s.started('trn_3');
    s.finished('trn_3', 'failed');
    const retro = retroOf(s.events);
    expect(retro.goal.request?.text).toBe('起始请求');
    expect(retro.decisions.map((d) => [d.kind, d.text])).toEqual([
      ['answer', '用哪种缓存？ → Redis'],
      ['declined', 'git push --force'],
      ['steer', '别改公共接口'],
      ['cancelled', ''],
      ['instruction', '换成 Redis 再试'],
    ]);
    expect(retro.turns.find((turn) => turn.turnId === 'trn_2')?.kind).toBe('report');
    expect(retro.open).toEqual([
      expect.objectContaining({ origin: 'turn', status: 'failed', id: 't:trn_3' }),
    ]);
    expect(retro.next.map((n) => n.kind)).toContain('retry_turn');
  });

  it('交付状态分开：未提交、未推送、CI 与部署未知可以同时存在', () => {
    const s = stream();
    created(s);
    s.user('trn_1', 'x');
    s.started('trn_1');
    s.finished('trn_1');
    s.run({ status: 'passed', codeState: GIT_A });
    const sha = 'd'.repeat(40);
    const retro = retroOf(
      s.events,
      live({
        codeState: GIT_A,
        uncommitted: 2,
        ahead: 1,
        commits: [{ sha, subject: 'Add x', at: T1 }],
      }),
    );
    expect(retro.delivery).toEqual({
      checks: 'passed',
      commit: 'uncommitted',
      push: 'not_pushed',
      ci: 'unknown',
      deploy: 'unknown',
      ahead: 1,
    });
    expect(retro.next.map((n) => n.kind)).toEqual(['commit', 'push']);
    const unknown = retroOf(
      s.events,
      live({ repo: false, uncommitted: undefined, upstream: undefined }),
    );
    expect(unknown.delivery).toMatchObject({ commit: 'unknown', push: 'unknown' });
    // 没有上游时分开“仓库没有远端”与“有远端、分支没设上游”。
    const noRemote = retroOf(s.events, live({ codeState: GIT_A, upstream: false, remote: false }));
    expect(noRemote.delivery.push).toBe('no_remote');
    const noUpstream = retroOf(s.events, live({ codeState: GIT_A, upstream: false, remote: true }));
    expect(noUpstream.delivery.push).toBe('no_upstream');
  });

  it('护栏拦截记为关键决定：摘要输入里写成护栏拦下，不是用户的决定', () => {
    const s = stream();
    created(s);
    s.user('trn_1', '提交并推送');
    s.started('trn_1');
    s.push('guardrail.blocked', {
      guardrailId: 'grd_01JA2B3C4D5E6F7G8H9JKMNPR5',
      kind: 'forbidden_command',
      action: 'denied',
      turnId: 'trn_1',
      tool: 'Bash',
      command: 'git push --force',
      reason: 'Blocked by guardrail: git push --force',
    });
    s.finished('trn_1');
    const retro = retroOf(s.events);
    expect(retro.decisions.map((d) => [d.kind, d.text])).toEqual([
      ['guardrail', 'git push --force: Blocked by guardrail: git push --force'],
    ]);
    expect(retroSummaryInput(retro)).toContain('guardrail blocked: git push --force');
  });
});

describe('任务回顾：投影', () => {
  function sample(): WevirEvent[] {
    const s = stream();
    created(s);
    for (let index = 1; index <= 6; index += 1) {
      const turnId = `trn_${index}`;
      s.user(turnId, `第 ${index} 步`);
      s.started(turnId);
      s.edit(turnId, `src/f${index % 3}.ts`);
      s.shell(turnId, `pnpm test --filter ${index}`, index % 2 === 0 ? 'failed' : 'completed');
      s.push('todo.updated', {
        turnId,
        toolCallId: `todo-${index}`,
        items: [{ content: `项 ${index}`, status: index % 2 === 0 ? 'completed' : 'pending' }],
      });
      s.finished(turnId);
      s.run({
        id: `vrn_0${index}` as never,
        status: index % 2 === 0 ? 'passed' : 'failed',
        codeState: GIT_A,
      });
      if (index === 3) s.push('turn.undone', { turnId });
      if (index === 4) s.push('turn.redone', { turnId: 'trn_3' });
      if (index === 5) s.push('turn.undone', { turnId });
    }
    return s.events;
  }

  it('增量更新与全量生成结果一致（任意切分）', () => {
    const events = sample();
    const full = foldRetro(emptyRetroState(), events);
    for (const cut of [1, 3, 10, 17, events.length - 1]) {
      const first = foldRetro(emptyRetroState(), events.slice(0, cut));
      // 存下再读回（经 JSON），然后只喂新事件；多喂了几条旧事件也不算两次。
      const reread = parseRetroState(JSON.stringify(first));
      expect(reread).toBeDefined();
      const incremental = foldRetro(reread as never, events.slice(Math.max(0, cut - 2)));
      expect(incremental).toEqual(full);
    }
    const chunked = events.reduce((state, event) => foldRetro(state, [event]), emptyRetroState());
    expect(chunked).toEqual(full);
  });

  it('读回投影：坏的、版本不同的都认不出（调用方从头重放）', () => {
    expect(parseRetroState('{not json')).toBeUndefined();
    expect(parseRetroState('null')).toBeUndefined();
    expect(parseRetroState(JSON.stringify({ ...emptyRetroState(), v: 1 }))).toBeUndefined();
    expect(
      parseRetroState(JSON.stringify({ ...emptyRetroState(), turns: [{ turnId: 1 }] })),
    ).toBeUndefined();
    expect(parseRetroState(JSON.stringify(emptyRetroState()))).toEqual(emptyRetroState());
  });
});

describe('任务回顾：导出与摘要', () => {
  it('脱敏：导出的内容里没有密钥样本', () => {
    const secrets = [
      `sk-${'a1B2'.repeat(10)}`,
      `ghp_${'x'.repeat(36)}`,
      'AKIAABCDEFGHIJKLMNOP',
      `Bearer ${'t'.repeat(40)}`,
      `AIza${'k'.repeat(35)}`,
      `xoxb-${'1'.repeat(12)}`,
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    ];
    const s = stream();
    created(s);
    s.user('trn_1', `用这个 key：${secrets[0]} 和 ${secrets[6]}`);
    s.started('trn_1');
    s.shell('trn_1', `curl -H "Authorization: ${secrets[3]}" https://api`);
    s.shell('trn_1', `export GH=${secrets[1]} AWS=${secrets[2]} G=${secrets[4]} S=${secrets[5]}`);
    s.finished('trn_1');
    const retro = retroOf(s.events);
    const { retro: redacted, count } = redactRetro(retro);
    const json = JSON.stringify(redacted);
    const markdown = retroMarkdown(redacted);
    for (const text of [json, markdown]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
      for (const pattern of SECRET_PATTERNS)
        expect(pattern.test(text), String(pattern)).toBe(false);
    }
    // 用户消息在“起始请求”与回合里各出现一次。
    expect(count).toBe(secrets.length + 2);
    expect(json).toContain('[REDACTED]');
  });

  it('摘要：输入每行带 ID；输出只认骨架里的 ID，没有出处的点标“推断”', () => {
    const s = stream();
    created(s);
    const request = s.user('trn_1', '修好温度换算');
    s.started('trn_1');
    s.shell('trn_1', 'pnpm test');
    s.finished('trn_1');
    const retro = retroOf(s.events);
    const input = retroSummaryInput(retro);
    expect(input).toContain(`[e${request.seq}] first request: 修好温度换算`);
    expect(input).toContain('no verification records (unverified)');
    expect(input).toContain('not verification');
    const points = parseRetroSummary(
      JSON.stringify({
        points: [
          { text: '在修温度换算。', refs: [`e${request.seq}`, 'e999', `e${request.seq}`] },
          { text: '测试大概过了。', refs: ['made-up'] },
          { text: '', refs: [] },
        ],
      }),
      retroIds(retro),
    );
    expect(points).toEqual([
      { text: '在修温度换算。', refs: [`e${request.seq}`] },
      { text: '测试大概过了。', refs: [], inferred: true },
    ]);
    expect(parseRetroSummary('not json', retroIds(retro))).toBeUndefined();
    expect(parseRetroSummary('{"points": []}', retroIds(retro))).toBeUndefined();
  });

  it('读提示词：去掉注释，不残留模板记号', () => {
    const text = loadRetroInstructions();
    expect(text.startsWith('你为 Wevir 的“任务回顾”写摘要')).toBe(true);
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('{{');
  });
});
