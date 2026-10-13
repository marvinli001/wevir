/** 页面在后台（窗口最小化、被遮住）时 requestAnimationFrame 不触发，改用这个间隔的计时器冲刷。 */
const HIDDEN_FLUSH_MS = 100;

/**
 * 下一帧执行一次（T5.3：可见内容按帧冲刷增量）。页面不可见时退回 100 ms 的计时器，后台积压的事件照样
 * 应用、只是不按帧。返回取消函数。
 */
export function scheduleFrame(callback: () => void): () => void {
  if (document.visibilityState === 'hidden') {
    const timer = window.setTimeout(callback, HIDDEN_FLUSH_MS);
    return () => window.clearTimeout(timer);
  }
  const frame = window.requestAnimationFrame(callback);
  return () => window.cancelAnimationFrame(frame);
}

/** 把多次 `request()` 合并成每帧至多一次 `flush`。 */
export function frameBatcher(flush: () => void): { request(): void; cancel(): void } {
  let cancel: (() => void) | undefined;
  return {
    request() {
      cancel ??= scheduleFrame(() => {
        cancel = undefined;
        flush();
      });
    },
    cancel() {
      cancel?.();
      cancel = undefined;
    },
  };
}
