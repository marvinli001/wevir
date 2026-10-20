// 验证记录绑定的代码状态（0.65.0，ADR-0008 决策 5）：Git 仓库里是 HEAD 加上工作树（含未跟踪、未忽略的文件）的树散列，
// 用临时索引算，不碰用户的索引与引用；绑不上时如实说明原因。

import type { CodeState } from '@wevir/protocol';
import { captureBlocker, workingTreeHash } from '../checkpoints.js';
import { repoInfo } from '../git-diff.js';

/** 算一次代码状态的时限（同回合快照）。 */
export const CODE_STATE_TIMEOUT_MS = 15_000;

/** 目录此刻的代码状态。不抛错：git 出错或超时是 `none`（`unavailable`）。 */
export async function readCodeState(cwd: string, signal?: AbortSignal): Promise<CodeState> {
  const repo = await repoInfo(cwd);
  if (!repo) return { kind: 'none', reason: 'not_git' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODE_STATE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const blocker = await captureBlocker(repo, controller.signal);
    if (blocker !== undefined) {
      return { kind: 'none', reason: blocker === 'sparse_checkout' ? blocker : 'too_large' };
    }
    const tree = await workingTreeHash(repo, controller.signal);
    return { kind: 'git', head: repo.head ?? null, tree };
  } catch {
    return { kind: 'none', reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 两个代码状态是不是同一个：只有都绑上了 git 才比得出来；绑不上的一律当作“不知道”，返回 undefined。 */
export function sameCodeState(
  a: CodeState | undefined,
  b: CodeState | undefined,
): boolean | undefined {
  if (a?.kind !== 'git' || b?.kind !== 'git') return undefined;
  return a.head === b.head && a.tree === b.tree;
}
