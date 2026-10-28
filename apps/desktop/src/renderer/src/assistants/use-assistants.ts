// 助理页的数据（0.120.0）：列表读 `channel.list`（助理与群，0.133.0），之后按 `channels.changed` 增量套用（版本不连续、重连后重读）；选中的助理读
// `channel.get` 与最近一页帖子，再 `watchChannel` 从最后一条接着收新帖与变化，往前翻页用 `channel.posts` 的 `beforeSeq`。

import type { WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelId, ChannelPost } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type AssistantView,
  applyListChange,
  applyUpdate,
  mergePosts,
  sortAssistants,
} from './assistants-model';

/** 一页帖子。 */
const PAGE = 50;

export interface AssistantList {
  channels?: Channel[];
  error?: unknown;
}

export function useAssistantList(client: WevirClient): AssistantList {
  const [state, setState] = useState<{
    list?: { channels: Channel[]; listVersion: number };
    error?: unknown;
  }>({});
  const listRef = useRef(state.list);
  listRef.current = state.list;
  useEffect(() => {
    let alive = true;
    let seq = 0;
    const load = () => {
      const id = ++seq;
      client.request('channel.list', {}).then(
        (list) => {
          if (alive && id === seq) setState({ list });
        },
        (error: unknown) => {
          if (alive && id === seq) setState((current) => ({ ...current, error }));
        },
      );
    };
    const off = client.onChannelsChanged((change) => {
      const current = listRef.current;
      const next = change && current ? applyListChange(current, change) : undefined;
      if (next === undefined) {
        load();
        return;
      }
      listRef.current = next;
      setState({ list: next });
    });
    load();
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return {
    ...(state.list !== undefined && { channels: sortAssistants(state.list.channels) }),
    ...(state.error !== undefined && { error: state.error }),
  };
}

export interface AssistantViewState {
  view?: AssistantView;
  error?: unknown;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** 发帖后立即放进时间线（订阅随后也会送来同一条）。 */
  addPost: (post: ChannelPost) => void;
}

export function useAssistantView(client: WevirClient, channelId: ChannelId): AssistantViewState {
  const [view, setView] = useState<AssistantView>();
  const [error, setError] = useState<unknown>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    let alive = true;
    let stop: (() => void) | undefined;
    setView(undefined);
    setError(undefined);
    const load = async () => {
      const [detail, page] = await Promise.all([
        client.request('channel.get', { channelId }),
        client.request('channel.posts', { channelId, limit: PAGE }),
      ]);
      if (!alive) return;
      setView({
        ...detail,
        posts: page.posts,
        hasOlder: (page.posts[0]?.seq ?? 1) > 1,
      });
      stop?.();
      stop = client.watchChannel(
        channelId,
        {
          onPost: (post) =>
            setView((current) =>
              current ? { ...current, posts: mergePosts(current.posts, [post]) } : current,
            ),
          onUpdate: (update) =>
            setView((current) => (current ? applyUpdate(current, update) : current)),
          onError: (reason) => setError(reason),
        },
        { afterSeq: page.lastSeq },
      );
    };
    load().catch((reason: unknown) => {
      if (alive) setError(reason);
    });
    // 重连后（列表的监听收到 undefined）线程与审批可能变了，重读一次；时间线由订阅接着补。
    const off = client.onChannelsChanged((change) => {
      if (change !== undefined) {
        const upserted = change.upserted.find((item) => item.id === channelId);
        if (upserted !== undefined) {
          setView((current) => (current ? { ...current, channel: upserted } : current));
        }
        return;
      }
      client.request('channel.get', { channelId }).then(
        (detail) => {
          if (alive) setView((current) => (current ? { ...current, ...detail } : current));
        },
        () => undefined,
      );
    });
    return () => {
      alive = false;
      off();
      stop?.();
    };
  }, [client, channelId]);

  const loadOlder = useCallback(() => {
    const current = viewRef.current;
    const first = current?.posts[0]?.seq;
    if (current === undefined || !current.hasOlder || first === undefined) return;
    setLoadingOlder(true);
    client
      .request('channel.posts', { channelId, beforeSeq: first, limit: PAGE })
      .then(
        (page) =>
          setView((latest) =>
            latest
              ? {
                  ...latest,
                  posts: mergePosts(latest.posts, page.posts),
                  hasOlder: page.posts.length === PAGE && (page.posts[0]?.seq ?? 1) > 1,
                }
              : latest,
          ),
        (reason: unknown) => setError(reason),
      )
      .finally(() => setLoadingOlder(false));
  }, [client, channelId]);

  const addPost = useCallback((post: ChannelPost) => {
    setView((current) =>
      current ? { ...current, posts: mergePosts(current.posts, [post]) } : current,
    );
  }, []);

  return {
    ...(view !== undefined && { view }),
    ...(error !== undefined && { error }),
    loadingOlder,
    loadOlder,
    addPost,
  };
}
