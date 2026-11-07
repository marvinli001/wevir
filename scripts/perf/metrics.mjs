import { monitorEventLoopDelay } from 'node:perf_hooks';

export function hostMetrics() {
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lastTick = performance.now();
  let drift = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    drift = Math.max(drift, now - lastTick - 10);
    lastTick = now;
  }, 10);
  return {
    sample() {
      const now = performance.now();
      const eventLoop = {
        count: histogram.count,
        maxMs: histogram.max / 1e6,
        p99Ms: histogram.count ? histogram.percentile(99) / 1e6 : null,
        // Electron may run this sampler before its overdue native histogram timer.
        timerDriftMaxMs: Math.max(0, drift, now - lastTick - 10),
      };
      histogram.reset();
      drift = 0;
      lastTick = now;
      return { at: Date.now(), pid: process.pid, memory: process.memoryUsage(), eventLoop };
    },
    close() {
      clearInterval(heartbeat);
      histogram.disable();
    },
  };
}

// Install before react-dom loads; its production build also calls this DevTools hook.
export function installCommitProbe() {
  let active;
  const hook = {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot(_renderer, root) {
      if (!active) return;
      const time = performance.now();
      const second = Math.floor((time - active.start) / 1000);
      active.buckets[second] = (active.buckets[second] ?? 0) + 1;
      const visit = (fiber) => {
        if (!fiber) return;
        if (fiber.flags & 1) {
          const props = fiber.memoizedProps;
          if (props?.draftKey && props.onSend) active.composerRenders++;
          if (
            props?.session &&
            fiber.child?.type === 'div' &&
            fiber.child.memoizedProps?.className ===
              'flex h-full min-h-0 flex-col animate-in fade-in duration-200 ease-smooth'
          )
            active.sessionViewRenders++;
        }
        visit(fiber.child);
        visit(fiber.sibling);
      };
      visit(root?.current);
      performance.measure('wevir.react.commit', { start: time, duration: 0 });
      performance.clearMeasures('wevir.react.commit');
    },
    onCommitFiberUnmount() {},
  };
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  globalThis.__wevirPerf = {
    start() {
      active = { start: performance.now(), buckets: [], composerRenders: 0, sessionViewRenders: 0 };
    },
    stop() {
      const durationMs = performance.now() - active.start;
      const perSecond = Array.from(
        { length: Math.ceil(durationMs / 1000) },
        (_, index) => active.buckets[index] ?? 0,
      );
      const commits = perSecond.reduce((sum, value) => sum + value, 0);
      const { composerRenders, sessionViewRenders } = active;
      active = undefined;
      return {
        durationMs,
        commits,
        composerRenders,
        sessionViewRenders,
        perSecond,
        commitsPerSecond: commits / (durationMs / 1000),
        visibility: document.visibilityState,
      };
    },
  };
}
