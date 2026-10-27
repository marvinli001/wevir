import { useEffect } from 'react';
import { useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';

/** 至少显示多久（从页面开始加载算）：数据来得很快时也不会一闪而过，又不让已经画好的工作台多等。 */
const MIN_VISIBLE_MS = 400;
/** 最多等多久：Host 迟迟连不上（重新启动中、在等外部 Host）时也撤掉，交给工作台与连接通知说明情况。 */
const MAX_VISIBLE_MS = 8000;
/** 淡出的时长，同 public/splash.css 的 transition。 */
const FADE_MS = 260;

/** 淡出并移除 index.html 的启动画面。只做一次。 */
function dismissSplash(): void {
  const splash = document.getElementById('splash');
  if (!splash || splash.dataset.leaving !== undefined) return;
  splash.dataset.leaving = '';
  window.setTimeout(() => splash.remove(), FADE_MS + 60);
}

function after(ms: number, run: () => void): () => void {
  const timer = window.setTimeout(run, Math.max(0, ms - performance.now()));
  return () => window.clearTimeout(timer);
}

/**
 * 启动画面（index.html 的 #splash，样式在 public/splash.css）在首帧就画出品牌主标与流光；工作区与会话列表第一次读到
 * （或第一次就连不上 Host）时撤掉，露出已经画好的工作台。不渲染任何东西。
 */
export function SplashGate() {
  const { view } = useHostConnection();
  const data = useWorkbenchData();
  const settled = data.status !== 'loading' || view.status === 'failed' || view.status === 'closed';

  useEffect(() => after(MAX_VISIBLE_MS, dismissSplash), []);
  useEffect(() => (settled ? after(MIN_VISIBLE_MS, dismissSplash) : undefined), [settled]);

  return null;
}
