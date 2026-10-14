// 窗口左上角的后退 / 前进（U5，照 Codex 桌面端）：hash 路由的历史里 React Router 给每一条记了序号
// （history.state.idx），能不能后退看当前序号，能不能前进看后退之前到过的最大序号。新开一条（PUSH）时前面的
// 记录作废，最大序号回到当前。

import { useEffect } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router';
import { createStore } from './store';

const position = createStore({ index: 0, last: 0 });

function historyIndex(): number {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : 0;
}

/** 在路由根上调用一次：每次换地址时记下序号。 */
export function useTrackHistory(): void {
  const location = useLocation();
  const type = useNavigationType();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 每次换地址（location.key）都要重读序号。
  useEffect(() => {
    const index = historyIndex();
    position.set((current) => {
      const last = type === 'PUSH' ? index : Math.max(current.last, index);
      return current.index === index && current.last === last ? current : { index, last };
    });
  }, [location.key, type]);
}

export function useHistoryNav() {
  const navigate = useNavigate();
  const { index, last } = position.use();
  return {
    canBack: index > 0,
    canForward: index < last,
    back: () => navigate(-1),
    forward: () => navigate(1),
  };
}
