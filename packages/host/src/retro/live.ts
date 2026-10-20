// 任务回顾里现读的部分（ADR-0012 决策 6）：不在事件里的东西每次 `retro.get` 都重读，不存进投影。每一项单独读，读不出只让那一格
// 写“未知”，不影响别的格子，也不抛错。

import { checkpointRef, type TurnCheckpoints } from '../checkpoints.js';
import { repoInfo, runGit } from '../git-diff.js';
import { readGitStatus } from '../git-status.js';
import type { MemoryStore } from '../memory.js';
import type { ReviewService } from '../review/service.js';
import { readCodeState } from '../verification/code-state.js';
import type { RetroLive, RetroLiveCheckpoint } from './build.js';
import type { RetroState } from './fold.js';

/** “会话期间的提交”最多列几条。 */
export const RETRO_MAX_COMMITS = 50;
/** 最多读最近几个回合的快照改到的文件（每个回合一次 `git diff --name-status`）。 */
export const RETRO_MAX_TURN_PATHS = 50;

export interface RetroLiveDeps {
  checkpoints?: TurnCheckpoints;
  review?: ReviewService;
  memory?: MemoryStore;
  /** 会话还在不在、标题（Host 的存储）。 */
  session: (sessionId: string) => { title?: string } | undefined;
  /** 批注所在目录的 realpath（同 `review.list`）。 */
  resolveDir?: (dir: string) => Promise<string>;
}

export interface RetroLiveTarget {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  /** 会话已关闭（关闭时 Host 删掉它的回合快照）。 */
  closed: boolean;
  state: RetroState;
}

async function settle<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

export async function readRetroLive(
  deps: RetroLiveDeps,
  target: RetroLiveTarget,
): Promise<RetroLive> {
  const checkedAt = new Date().toISOString();
  const repo = await settle(repoInfo(target.cwd));
  const live: RetroLive = { checkedAt, repo: repo !== undefined, session: deps.session };

  const [codeState, checkpoints, status, review, memories] = await Promise.all([
    settle(readCodeState(target.cwd)),
    repo === undefined || deps.checkpoints === undefined
      ? Promise.resolve(undefined)
      : settle(deps.checkpoints.list(target.sessionId, target.cwd)),
    repo === undefined ? Promise.resolve(undefined) : settle(readGitStatus(target.cwd)),
    deps.review === undefined
      ? Promise.resolve(undefined)
      : settle(
          (async () => {
            const dir = (await deps.resolveDir?.(target.cwd)) ?? target.cwd;
            const comments = await (deps.review as ReviewService).list({
              workspaceId: target.workspaceId as never,
              dir,
            });
            return comments.filter((comment) => comment.sessionId === target.sessionId);
          })(),
        ),
    deps.memory === undefined
      ? Promise.resolve(undefined)
      : settle(deps.memory.list(target.workspaceId)),
  ]);
  if (codeState !== undefined) live.codeState = codeState;
  if (review !== undefined) live.review = review;
  if (memories !== undefined) {
    live.memories = new Set(memories.map((note) => `${note.scope}:${note.name}`));
  }
  if (repo === undefined) return live;

  if (checkpoints !== undefined) {
    const map = new Map<string, RetroLiveCheckpoint>();
    for (const turn of checkpoints.turns) {
      map.set(turn.turnId, {
        after: turn.fileCount !== undefined,
        ...(turn.fileCount !== undefined && { fileCount: turn.fileCount }),
        ...(turn.added !== undefined && { added: turn.added }),
        ...(turn.removed !== undefined && { removed: turn.removed }),
      });
    }
    const recent = target.state.turns
      .filter((turn) => turn.hidden !== true && map.get(turn.turnId)?.after === true)
      .slice(-RETRO_MAX_TURN_PATHS);
    const store = deps.checkpoints as TurnCheckpoints;
    await Promise.all(
      recent.map(async (turn) => {
        const paths = await settle(store.changedPaths(target.sessionId, target.cwd, turn.turnId));
        const entry = map.get(turn.turnId);
        if (paths !== undefined && entry !== undefined) map.set(turn.turnId, { ...entry, paths });
      }),
    );
    live.checkpoints = map;
    if (target.closed && map.size === 0) live.checkpointsDropped = true;
  }
  if (status?.repo === true && status.fileCount !== undefined) live.uncommitted = status.fileCount;
  live.head = repo.head ?? null;
  if (repo.branch !== undefined) live.branch = repo.branch;

  const base = await settle(sessionBase(repo, target));
  if (base !== undefined && repo.head !== undefined && base !== repo.head) {
    const log = await settle(
      runGit(repo.cwd, [
        ...repo.config,
        'log',
        '--no-decorate',
        '--format=%H%x00%s%x00%cI',
        '-n',
        String(RETRO_MAX_COMMITS),
        `${base}..HEAD`,
      ]),
    );
    if (log !== undefined) {
      live.commits = log.stdout
        .toString('utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [sha = '', subject = '', at = ''] = line.split('\0');
          return { sha, subject, at: new Date(at).toISOString() };
        })
        .filter((commit) => /^[0-9a-f]{40,64}$/.test(commit.sha));
    }
  } else if (base !== undefined) {
    live.commits = [];
  }

  if (repo.branch !== undefined) {
    const upstream = await settle(
      runGit(
        repo.cwd,
        [...repo.config, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { okCodes: [0, 128] },
      ),
    );
    if (upstream !== undefined) {
      live.upstream = upstream.code === 0;
      if (live.upstream) {
        const ahead = await settle(
          runGit(repo.cwd, [...repo.config, 'rev-list', '--count', '@{upstream}..HEAD']),
        );
        const count = Number.parseInt(ahead?.stdout.toString('utf8').trim() ?? '', 10);
        if (Number.isInteger(count)) live.ahead = count;
      }
    }
  }
  return live;
}

/**
 * 会话开始时的 HEAD：会话第一个回合（分支抄来的不算）的回合前快照的父提交（快照是 `commit-tree -p HEAD`）；快照没了时用最早一条
 * 验证记录绑的 HEAD。都没有时 undefined（不列提交）。
 */
async function sessionBase(
  repo: NonNullable<Awaited<ReturnType<typeof repoInfo>>>,
  target: RetroLiveTarget,
): Promise<string | undefined> {
  const inheritedThrough = target.state.inheritedThrough ?? 0;
  const first = target.state.turns.find((turn) => turn.seq > inheritedThrough);
  if (first !== undefined) {
    const ref = checkpointRef(target.sessionId, first.turnId, 'before');
    const result = await runGit(
      repo.cwd,
      [...repo.config, 'rev-parse', '--verify', '--quiet', `${ref}^1`],
      { okCodes: [0, 1, 128] },
    );
    const sha = result.stdout.toString('utf8').trim();
    if (result.code === 0 && sha !== '') return sha;
  }
  for (const entry of target.state.runs) {
    const state = entry.run.codeState;
    if (state?.kind === 'git' && state.head !== null) return state.head;
  }
  return undefined;
}
