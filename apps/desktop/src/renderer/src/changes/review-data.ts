// 行级批注的数据（0.67.0，`review.*`）：会话目录里的批注。Host 每次读批注时现算位置，所以 diff 重读（`refreshKey` 变了）、
// 窗口获得焦点时一起重读。

import { hostSupports } from '@wevir/client-sdk';
import type {
  MethodParams,
  ReviewComment,
  ReviewCommentId,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { useCallback, useEffect, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';

/** Host 声明了 `review_comments`（0.67.0）。 */
export function useReviewSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'review_comments');
}

export type ReviewDraft = Omit<MethodParams<'review.add'>, 'workspaceId' | 'sessionId'>;

export interface ReviewState {
  comments: readonly ReviewComment[];
  error: string | undefined;
  refresh(): void;
  add(draft: ReviewDraft): Promise<ReviewComment>;
  remove(ids: readonly ReviewCommentId[]): Promise<void>;
  send(
    ids: readonly ReviewCommentId[],
    targetSessionId: SessionId,
  ): Promise<{ turnId?: string; pendingId?: string }>;
}

const NONE: readonly ReviewComment[] = [];

export function useReviewComments(
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  refreshKey: unknown,
): ReviewState {
  const { client } = useHostConnection();
  const supported = useReviewSupported();
  const [state, setState] = useState<{ key: string; comments: readonly ReviewComment[] }>();
  const [error, setError] = useState<string>();
  const [manual, setManual] = useState(0);
  const key = `${workspaceId}:${sessionId}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 与 manual 只用来触发重读。
  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    const read = () => {
      client
        .request('review.list', { workspaceId, sessionId, status: 'pending' })
        .then((result) => {
          if (stopped) return;
          setState({ key, comments: result.comments });
          setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      stopped = true;
      window.removeEventListener('focus', read);
    };
  }, [client, supported, workspaceId, sessionId, key, refreshKey, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);

  const add = useCallback(
    async (draft: ReviewDraft) => {
      if (!client) throw new Error('not connected');
      const { comment } = await client.request('review.add', { workspaceId, sessionId, ...draft });
      setState((current) => ({
        key,
        comments: [...(current?.key === key ? current.comments : []), comment],
      }));
      return comment;
    },
    [client, workspaceId, sessionId, key],
  );

  const remove = useCallback(
    async (ids: readonly ReviewCommentId[]) => {
      if (!client || ids.length === 0) return;
      await client.request('review.remove', { commentIds: [...ids] });
      setState((current) =>
        current?.key === key
          ? { key, comments: current.comments.filter((comment) => !ids.includes(comment.id)) }
          : current,
      );
    },
    [client, key],
  );

  const send = useCallback(
    async (ids: readonly ReviewCommentId[], targetSessionId: SessionId) => {
      if (!client) throw new Error('not connected');
      const result = await client.request('review.send', {
        workspaceId,
        sessionId,
        commentIds: [...ids],
        targetSessionId,
        delivery: 'queue',
      });
      setState((current) =>
        current?.key === key
          ? { key, comments: current.comments.filter((comment) => !ids.includes(comment.id)) }
          : current,
      );
      return {
        ...(result.turnId !== undefined && { turnId: result.turnId }),
        ...(result.pendingId !== undefined && { pendingId: result.pendingId }),
      };
    },
    [client, workspaceId, sessionId, key],
  );

  return {
    comments: state?.key === key ? state.comments : NONE,
    error,
    refresh,
    add,
    remove,
    send,
  };
}
