// 从投影状态（fold.ts）与现读的结果（live.ts）组出协议的 `SessionRetro`（ADR-0012 决策 7、8）。纯函数：同样的输入给同样的回顾，
// 测试直接构造现读结果。证据语义集中在这里：“通过”只来自验证记录，再和此刻的代码状态比；Agent 跑的命令与它说的话都不算。

import { isAbsolute, relative, sep } from 'node:path';
import {
  type CodeState,
  RETRO_CHECK_EARLIER_MAX,
  RETRO_SCHEMA_VERSION,
  RETRO_TEXT_MAX_CHARS,
  type RetroChapter,
  type RetroCheck,
  type RetroCommand,
  type RetroCommit,
  type RetroDecision,
  type RetroDelivery,
  type RetroDiffState,
  type RetroFile,
  type RetroMemory,
  type RetroNext,
  type RetroRelatedSession,
  type RetroReviewComment,
  type RetroSourceState,
  type RetroTurn,
  type RetroWorkItem,
  type ReviewComment,
  type SessionId,
  type SessionRetro,
  type TurnId,
  type VerificationRunId,
} from '@wevir/protocol';
import { clipText, type RetroState, type RetroStateRun, type RetroStateTurn } from './fold.js';

/** 各部分的条数上限；超出时报省略的条数。 */
export const RETRO_MAX_DECISIONS = 40;
export const RETRO_MAX_COMMANDS = 30;
export const RETRO_MAX_FILES = 200;
export const RETRO_MAX_TURNS = 200;
export const RETRO_MAX_OPEN_ITEMS_IN_NEXT = 5;

/** 一个回合的快照（现读，同 `session.checkpoints`）：有回合后的快照时带统计。 */
export interface RetroLiveCheckpoint {
  after: boolean;
  /** 前后快照之间改到的文件（相对会话目录）；只读最近的几十个回合，没读的省略。 */
  paths?: readonly string[];
  fileCount?: number;
  added?: number;
  removed?: number;
}

/** 现读的结果。每一项读不出时省略（回顾里写“未知”）。 */
export interface RetroLive {
  checkedAt: string;
  /** 目录是不是 git 仓库；省略表示不知道。 */
  repo?: boolean;
  codeState?: CodeState;
  /** 有快照的回合；省略表示读不出。 */
  checkpoints?: ReadonlyMap<string, RetroLiveCheckpoint>;
  /** 会话的快照被整体删掉了（会话关闭时 Host 删它的快照）。 */
  checkpointsDropped?: boolean;
  head?: string | null;
  branch?: string;
  commits?: readonly { sha: string; subject: string; at: string }[];
  uncommitted?: number;
  /** 当前分支有没有上游；有时 `ahead` 是没推送的提交数。 */
  upstream?: boolean;
  ahead?: number;
  /** 写在这个会话里的批注；省略表示读不出（或 Host 没有批注）。 */
  review?: readonly ReviewComment[];
  /** 会话还在不在、标题（Host 的存储）。 */
  session?: (sessionId: string) => { title?: string } | undefined;
  /** 现有的记忆笔记（`<scope>:<name>`）；省略表示读不出。 */
  memories?: ReadonlySet<string>;
}

export interface BuildRetroInput {
  sessionId: SessionId;
  cwd: string;
  state: RetroState;
  live: RetroLive;
  builtAt: string;
  build: SessionRetro['build'];
}

function eventRef(seq: number, turnId?: string) {
  return {
    kind: 'event' as const,
    seq,
    ...(turnId !== undefined && { turnId: turnId as TurnId }),
  };
}

/** 回合的快照情况。 */
function diffState(
  turn: RetroStateTurn,
  live: RetroLive,
  oldest: string | undefined,
  active: boolean,
): RetroDiffState {
  if (live.repo === false) return 'not_git';
  if (live.checkpoints === undefined) return 'none';
  const checkpoint = live.checkpoints.get(turn.turnId);
  if (checkpoint?.after === true) return 'available';
  if (checkpoint !== undefined) return active ? 'live' : 'none';
  // 没有快照：会话关闭时整体删了，或超过每个会话留的回合数被删了（比现存最早的还早）。
  if (live.checkpointsDropped === true) return 'deleted';
  if (oldest !== undefined && turn.turnId < oldest) return 'deleted';
  return 'none';
}

/** 工具给的路径可能是绝对路径：在会话目录下的改成相对路径。 */
function displayPath(cwd: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

function changedFiles(turn: RetroStateTurn, live: RetroLive): boolean {
  if (turn.files.length > 0) return true;
  const checkpoint = live.checkpoints?.get(turn.turnId);
  return (checkpoint?.fileCount ?? 0) > 0 || (checkpoint?.paths?.length ?? 0) > 0;
}

/** 回合改到的文件：工具给的路径，加上回合快照之间的（引擎没报的、在 shell 里改的也在）。 */
function turnFiles(cwd: string, turn: RetroStateTurn, live: RetroLive): string[] {
  const paths = turn.files.map((path) => displayPath(cwd, path));
  for (const path of live.checkpoints?.get(turn.turnId)?.paths ?? []) {
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function buildRetro(input: BuildRetroInput): SessionRetro {
  const { sessionId, cwd, state, live } = input;
  const inheritedThrough = state.inheritedThrough ?? 0;
  const inherited = (seq: number) => (seq <= inheritedThrough ? { inherited: true as const } : {});
  const visible = state.turns.filter((turn) => turn.hidden !== true);
  const hiddenIds = new Set(
    state.turns.filter((turn) => turn.hidden === true).map((t) => t.turnId),
  );
  const running = state.activeTurnId !== undefined;
  const checkpointIds = live.checkpoints === undefined ? [] : [...live.checkpoints.keys()].sort();
  const oldest = checkpointIds[0];

  // ── 回合 ──
  const turns: RetroTurn[] = visible.slice(-RETRO_MAX_TURNS).map((turn) => {
    const checkpoint = live.checkpoints?.get(turn.turnId);
    const active = turn.turnId === state.activeTurnId;
    return {
      id: `t:${turn.turnId}`,
      turnId: turn.turnId as TurnId,
      seq: turn.startSeq ?? turn.seq,
      ...(turn.endSeq !== undefined && { endSeq: turn.endSeq }),
      ...(turn.outcome !== undefined && { outcome: turn.outcome as RetroTurn['outcome'] }),
      ...(turn.message !== undefined && { text: turn.message.text }),
      kind: turn.kind,
      files: turnFiles(cwd, turn, live),
      commands: turn.commands.length + turn.omittedCommands,
      diff: diffState(turn, live, oldest, active),
      ...(checkpoint?.fileCount !== undefined && { fileCount: checkpoint.fileCount }),
      ...(checkpoint?.added !== undefined && { added: checkpoint.added }),
      ...(checkpoint?.removed !== undefined && { removed: checkpoint.removed }),
      ...inherited(turn.seq),
      at: turn.ts,
    };
  });
  const turnById = new Map(turns.map((turn) => [turn.turnId as string, turn]));

  // ── 章节 ── 撤销的回合里标的不列，撤回的回合已不在状态里；回合归到它结束之前最后开始的那一章。
  const visibleIds = new Set(visible.map((turn) => turn.turnId));
  const chapters: RetroChapter[] = state.chapters
    .filter((chapter) => chapter.turnId === undefined || visibleIds.has(chapter.turnId))
    .map((chapter) => ({
      id: `h${chapter.seq}`,
      text: chapter.title,
      ...(chapter.summary !== undefined && { summary: chapter.summary }),
      ref: eventRef(chapter.seq, chapter.turnId),
      turns: 0,
      ...inherited(chapter.seq),
      at: chapter.ts,
    }));
  for (const turn of turns) {
    const end = turn.endSeq ?? Number.POSITIVE_INFINITY;
    const chapter = chapters.findLast((entry) => seqOf(entry) <= end);
    if (chapter === undefined) continue;
    turn.chapter = chapter.id;
    chapter.turns += 1;
  }

  // ── 目标 ──
  const firstUser = visible.find((turn) => turn.kind === 'user' && turn.message !== undefined);
  const goal: SessionRetro['goal'] = {
    recorded: state.goal !== undefined || firstUser !== undefined,
    ...(state.goal !== undefined && {
      goal: {
        id: `e${state.goal.seq}`,
        text: state.goal.objective,
        status: state.goal.status as NonNullable<SessionRetro['goal']['goal']>['status'],
        ref: eventRef(state.goal.seq),
        at: state.goal.ts,
      },
    }),
    ...(firstUser?.message !== undefined && {
      request: {
        id: `e${firstUser.message.seq}`,
        text: firstUser.message.text,
        ref: eventRef(firstUser.message.seq, firstUser.turnId),
        ...inherited(firstUser.message.seq),
        at: firstUser.ts,
      },
    }),
  };

  // ── 完成与未完成 ──
  const done: RetroWorkItem[] = [];
  const open: RetroWorkItem[] = [];
  let todoTurn: RetroStateTurn | undefined;
  for (const turn of visible) {
    if (turn.todos !== undefined && (todoTurn?.todos?.seq ?? 0) < turn.todos.seq) todoTurn = turn;
  }
  if (todoTurn?.todos !== undefined) {
    const { seq, items } = todoTurn.todos;
    items.forEach((item, index) => {
      if (item.status === 'cancelled' || item.status === 'canceled') return;
      const entry: RetroWorkItem = {
        id: `e${seq}.${index}`,
        text: item.content,
        origin: 'todo',
        status: item.status || 'pending',
        ref: eventRef(seq, todoTurn?.turnId),
        ...inherited(seq),
      };
      (item.status === 'completed' ? done : open).push(entry);
    });
  }
  if (state.board !== undefined) {
    const { seq, tasks } = state.board;
    for (const task of tasks) {
      if (task.status === 'cancelled') continue;
      const entry: RetroWorkItem = {
        id: `b:${task.id}`,
        text: task.subject,
        origin: 'board',
        status: task.status,
        ...(task.owner !== undefined && { owner: task.owner as SessionId }),
        ref: eventRef(seq),
      };
      (task.status === 'completed' ? done : open).push(entry);
    }
  }
  const pendingApprovals = state.pendingApprovals.filter((item) => !hiddenIds.has(item.turnId));
  const pendingQuestions = state.pendingQuestions.filter((item) => !hiddenIds.has(item.turnId));
  for (const approval of pendingApprovals) {
    open.push({
      id: `e${approval.seq}`,
      text: approval.text,
      origin: 'approval',
      status: 'pending',
      ref: eventRef(approval.seq, approval.turnId),
    });
  }
  for (const question of pendingQuestions) {
    open.push({
      id: `e${question.seq}`,
      text: question.text,
      origin: 'question',
      status: 'pending',
      ref: eventRef(question.seq, question.turnId),
    });
  }
  const lastTurn = visible.at(-1);
  const lastUnfinished =
    lastTurn !== undefined &&
    !running &&
    (lastTurn.outcome === 'failed' ||
      lastTurn.outcome === 'interrupted' ||
      lastTurn.outcome === 'cancelled')
      ? lastTurn
      : undefined;
  if (lastUnfinished !== undefined) {
    open.push({
      id: `t:${lastUnfinished.turnId}`,
      text: lastUnfinished.message?.text ?? '',
      origin: 'turn',
      status: lastUnfinished.outcome as string,
      ref: eventRef(lastUnfinished.endSeq ?? lastUnfinished.seq, lastUnfinished.turnId),
    });
  }

  // ── 改动 ──
  const byPath = new Map<string, TurnId[]>();
  for (const turn of visible) {
    for (const path of turnFiles(cwd, turn, live)) {
      const list = byPath.get(path) ?? [];
      list.push(turn.turnId as TurnId);
      byPath.set(path, list);
    }
  }
  const allFiles: RetroFile[] = [...byPath.entries()].map(([path, turnIds]) => {
    const last = turnIds.at(-1) as TurnId;
    const turn = turnById.get(last);
    return { id: `f:${path}`, path, turnIds, diff: turn?.diff ?? 'none' };
  });
  const files = allFiles.slice(0, RETRO_MAX_FILES);
  const commits: RetroCommit[] = (live.commits ?? []).map((commit) => ({
    id: `c:${commit.sha}`,
    sha: commit.sha,
    subject: clipText(commit.subject, RETRO_TEXT_MAX_CHARS),
    at: commit.at,
  }));
  const changes: SessionRetro['changes'] = {
    recorded: files.length > 0 || commits.length > 0 || (live.uncommitted ?? 0) > 0,
    ...(live.repo !== undefined && { repo: live.repo }),
    files,
    ...(allFiles.length > files.length && { omittedFiles: allFiles.length - files.length }),
    commits,
    ...(live.uncommitted !== undefined && { uncommitted: live.uncommitted }),
    ...(live.branch !== undefined && { branch: live.branch }),
    ...(live.head !== undefined && { head: live.head }),
  };

  // ── 验证 ──
  const byCheck = new Map<string, RetroStateRun[]>();
  for (const entry of [...state.runs].sort((a, b) => a.seq - b.seq)) {
    if (entry.run.turnId !== undefined && hiddenIds.has(entry.run.turnId)) continue;
    const list = byCheck.get(entry.run.checkId) ?? [];
    list.push(entry);
    byCheck.set(entry.run.checkId, list);
  }
  const checks: RetroCheck[] = [...byCheck.values()]
    .sort((a, b) => (a.at(-1) as RetroStateRun).seq - (b.at(-1) as RetroStateRun).seq)
    .map((list) => {
      const { seq, run } = list.at(-1) as RetroStateRun;
      const earlier = list
        .slice(0, -1)
        .slice(-RETRO_CHECK_EARLIER_MAX)
        .map((entry) => ({
          runId: entry.run.id,
          status: entry.run.status,
          ...(entry.run.reason !== undefined && { reason: entry.run.reason }),
          seq: entry.seq,
          ...(entry.run.turnId !== undefined && { turnId: entry.run.turnId }),
        }));
      let evidence: RetroCheck['evidence'];
      if (run.status === 'passed') {
        const same = sameCode(run.codeState, live.codeState);
        if (same === true) evidence = 'current';
        else if (same === false) evidence = 'outdated';
        else {
          // 比不出代码状态：看之后有没有改了文件的看得见回合。
          const changedAfter = visible.some(
            (turn) => (turn.endSeq ?? turn.seq) > seq && changedFiles(turn, live),
          );
          evidence = changedAfter ? 'outdated' : 'unbound';
        }
      }
      return {
        id: `v:${run.id}`,
        checkId: run.checkId,
        runId: run.id,
        name: run.name,
        command: run.command,
        kind: run.kind,
        status: run.status,
        ...(run.reason !== undefined && { reason: run.reason }),
        ...(evidence !== undefined && { evidence }),
        ...(run.codeState !== undefined && { codeState: run.codeState }),
        ...(run.tests !== undefined && { tests: run.tests }),
        ...(run.exitCode !== undefined && { exitCode: run.exitCode }),
        ...(run.turnId !== undefined && { turnId: run.turnId }),
        seq,
        ...(run.finishedAt !== undefined && { finishedAt: run.finishedAt }),
        ...(earlier.length > 0 && { earlier }),
      };
    });
  const allCommands: RetroCommand[] = visible.flatMap((turn) =>
    turn.commands.map((command) => ({
      id: `e${command.seq}`,
      text: command.text,
      ...(command.status !== undefined && { status: command.status }),
      ref: eventRef(command.seq, turn.turnId),
      ...inherited(command.seq),
    })),
  );
  const omittedEarlier = visible.reduce((sum, turn) => sum + turn.omittedCommands, 0);
  const commands = allCommands.slice(-RETRO_MAX_COMMANDS);
  const omittedCommands = allCommands.length - commands.length + omittedEarlier;
  const verification: SessionRetro['verification'] = {
    recorded: checks.length > 0,
    checks,
    ...(state.acceptance !== undefined &&
      checks.length > 0 && {
        acceptance: state.acceptance.status as NonNullable<
          SessionRetro['verification']['acceptance']
        >,
      }),
    commands,
    ...(omittedCommands > 0 && { omittedCommands }),
    ...(live.codeState !== undefined && { codeState: live.codeState }),
  };

  // ── 审阅 ──
  const review: SessionRetro['review'] = {
    recorded: live.review !== undefined,
    comments: (live.review ?? []).map(
      (comment): RetroReviewComment => ({
        id: `r:${comment.id}`,
        text: clipText(comment.body, RETRO_TEXT_MAX_CHARS),
        path: comment.path,
        line: comment.anchor.startLine ?? comment.startLine,
        status: comment.status,
        ...(comment.anchor.state === 'outdated' && { outdated: true as const }),
        ref: {
          kind: 'review',
          commentId: comment.id,
          path: comment.path,
          source: comment.source,
        },
        at: comment.createdAt,
      }),
    ),
  };

  // ── 关键决定 ──
  const decisionList: RetroDecision[] = [];
  for (const turn of visible) {
    if (turn !== firstUser && turn.kind === 'user' && turn.message !== undefined) {
      decisionList.push({
        id: `e${turn.message.seq}`,
        kind: 'instruction',
        text: turn.message.text,
        ref: eventRef(turn.message.seq, turn.turnId),
        ...inherited(turn.message.seq),
      });
    }
    for (const steer of turn.steers) {
      decisionList.push({
        id: `e${steer.seq}`,
        kind: 'steer',
        text: steer.text,
        ref: eventRef(steer.seq, turn.turnId),
        ...inherited(steer.seq),
      });
    }
    for (const decision of turn.decisions) {
      decisionList.push({
        id: `e${decision.seq}`,
        kind: decision.kind,
        text: decision.text,
        ref: eventRef(decision.seq, turn.turnId),
        ...inherited(decision.seq),
      });
    }
  }
  for (const decision of state.decisions) {
    decisionList.push({
      id: `e${decision.seq}`,
      kind: decision.kind,
      // 撤销的回合不出现：只留“撤销了一个回合”，不带它的内容。
      text: decision.text,
      ref: eventRef(decision.seq),
      ...inherited(decision.seq),
    });
  }
  decisionList.sort((a, b) => seqOf(a) - seqOf(b));
  const decisions = decisionList.slice(-RETRO_MAX_DECISIONS);

  // ── 交付状态 ──
  const delivery: RetroDelivery = {
    checks: checksStatus(checks),
    commit:
      live.repo === false || live.uncommitted === undefined
        ? 'unknown'
        : live.uncommitted > 0
          ? 'uncommitted'
          : commits.length > 0
            ? 'committed'
            : 'clean',
    push:
      live.repo === false || live.upstream === undefined
        ? 'unknown'
        : !live.upstream
          ? 'no_upstream'
          : (live.ahead ?? 0) > 0
            ? 'not_pushed'
            : 'pushed',
    ci: 'unknown',
    deploy: 'unknown',
    ...(live.upstream === true && live.ahead !== undefined && { ahead: live.ahead }),
  };

  // ── 关联 ──
  const sessionSource = (id: string): RetroSourceState => {
    if (live.session === undefined) return 'unknown';
    return live.session(id) === undefined ? 'deleted' : 'available';
  };
  const sessions: RetroRelatedSession[] = [];
  const forkedFrom = state.created?.forkedFrom;
  if (forkedFrom !== undefined) {
    sessions.push({
      id: `s:${forkedFrom.sessionId}`,
      text: live.session?.(forkedFrom.sessionId)?.title ?? '',
      sessionId: forkedFrom.sessionId as SessionId,
      relation: 'forked_from',
      source: sessionSource(forkedFrom.sessionId),
      ref: { kind: 'session', sessionId: forkedFrom.sessionId as SessionId },
    });
  }
  for (const child of state.children) {
    if (sessions.some((entry) => entry.sessionId === child.sessionId)) continue;
    sessions.push({
      id: `s:${child.sessionId}`,
      text: live.session?.(child.sessionId)?.title || child.text,
      sessionId: child.sessionId as SessionId,
      relation: child.relation,
      source: sessionSource(child.sessionId),
      ref: { kind: 'session', sessionId: child.sessionId as SessionId },
    });
  }
  const memories: RetroMemory[] = visible.flatMap((turn) =>
    turn.memory.map((memory) => ({
      id: `e${memory.seq}`,
      text: memory.name,
      scope: memory.scope,
      name: memory.name,
      operation: memory.operation,
      ...(memory.operation === 'save' && {
        source:
          live.memories === undefined
            ? ('unknown' as const)
            : live.memories.has(`${memory.scope}:${memory.name}`)
              ? ('available' as const)
              : ('deleted' as const),
      }),
      ref: { kind: 'memory' as const, scope: memory.scope, name: memory.name },
    })),
  );

  // ── 下一步 ──
  const next: RetroNext[] = [];
  const nextOf = (kind: string, from: { id: string; text: string; ref?: RetroNext['ref'] }) =>
    next.push({ id: `n:${from.id}`, kind, text: from.text, ...(from.ref && { ref: from.ref }) });
  for (const item of open) {
    if (item.origin === 'approval' || item.origin === 'question') nextOf('decide', item);
  }
  const checkRef = (check: RetroCheck) => ({
    id: check.id,
    text: check.name,
    ref: { kind: 'verification' as const, runId: check.runId as VerificationRunId, seq: check.seq },
  });
  for (const check of checks) {
    if (check.status === 'failed' || check.status === 'timed_out') {
      nextOf('fix_check', checkRef(check));
    } else if (check.status === 'environment_unavailable') {
      nextOf('environment', checkRef(check));
    } else if (check.status === 'passed' && check.evidence === 'outdated') {
      nextOf('rerun_check', checkRef(check));
    }
  }
  if (checks.length === 0) {
    const changed = [...visible].reverse().find((turn) => changedFiles(turn, live));
    if (changed !== undefined) {
      nextOf('run_checks', {
        id: `t:${changed.turnId}`,
        text: '',
        ref: eventRef(changed.endSeq ?? changed.seq, changed.turnId),
      });
    }
  }
  for (const comment of review.comments) {
    if (comment.status === 'pending') nextOf('send_review', comment);
  }
  if (lastUnfinished !== undefined) {
    nextOf('retry_turn', {
      id: `t:${lastUnfinished.turnId}`,
      text: lastUnfinished.message?.text ?? '',
      ref: eventRef(lastUnfinished.endSeq ?? lastUnfinished.seq, lastUnfinished.turnId),
    });
  }
  for (const item of open
    .filter((entry) => entry.origin === 'todo' || entry.origin === 'board')
    .slice(0, RETRO_MAX_OPEN_ITEMS_IN_NEXT)) {
    nextOf('open_item', item);
  }
  if (delivery.commit === 'uncommitted') {
    next.push({ id: 'n:commit', kind: 'commit', text: String(live.uncommitted ?? 0) });
  }
  if (delivery.push === 'not_pushed') {
    next.push({ id: 'n:push', kind: 'push', text: String(live.ahead ?? 0) });
  }

  return {
    sessionId,
    schemaVersion: RETRO_SCHEMA_VERSION,
    throughSeq: state.throughSeq,
    builtAt: input.builtAt,
    checkedAt: live.checkedAt,
    build: input.build,
    running,
    goal,
    done,
    open,
    boardRecorded: state.board !== undefined,
    turns,
    chapters,
    hiddenTurns: hiddenIds.size,
    changes,
    verification,
    review,
    decisions,
    ...(decisionList.length > decisions.length && {
      omittedDecisions: decisionList.length - decisions.length,
    }),
    delivery,
    next,
    sessions,
    memories,
  };
}

/**
 * 两个代码状态的内容是不是同一份：都绑上了 git 时比树散列（工作树含未跟踪的文件）。只提交、没改内容时 HEAD 变了但树相同，记录仍对得上
 * 现在的代码（回合后验证的验收状态把 HEAD 也算进去，见 ADR-0009 决策 12；回顾只回答“测的是不是这份代码”）。比不出来时 undefined。
 */
function sameCode(a: CodeState | undefined, b: CodeState | undefined): boolean | undefined {
  if (a?.kind !== 'git' || b?.kind !== 'git') return undefined;
  return a.tree === b.tree;
}

function seqOf(item: { ref?: RetroDecision['ref'] }): number {
  return item.ref?.kind === 'event' ? item.ref.seq : 0;
}

/** 本地检查的总体：有在跑的、失败的、环境不可用的依次优先；全部通过且都是当前版本（或比不出版本）才是 `passed`。 */
function checksStatus(checks: readonly RetroCheck[]): string {
  if (checks.length === 0) return 'unverified';
  if (checks.some((check) => check.status === 'running')) return 'running';
  if (checks.some((check) => check.status === 'failed' || check.status === 'timed_out')) {
    return 'failed';
  }
  if (checks.some((check) => check.status === 'environment_unavailable')) {
    return 'environment_unavailable';
  }
  if (checks.every((check) => check.status === 'passed')) {
    return checks.some((check) => check.evidence === 'outdated') ? 'outdated' : 'passed';
  }
  return 'unverified';
}
