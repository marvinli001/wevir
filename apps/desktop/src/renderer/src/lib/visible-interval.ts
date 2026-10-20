/**
 * 每 `ms` 调一次 `tick`，只在窗口看得见时计时：最小化、被遮住、切到别的桌面时停下（不再让 Host 去读 git、diff 这类只为显示的
 * 数据），重新看见时先调一次再接着计时。返回停止函数。第一次读由调用方自己做。
 */
export function everyWhileVisible(tick: () => void, ms: number): () => void {
  let timer: number | undefined;
  const start = () => {
    timer ??= window.setInterval(tick, ms);
  };
  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      stop();
    } else if (timer === undefined) {
      tick();
      start();
    }
  };
  if (document.visibilityState !== 'hidden') start();
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
