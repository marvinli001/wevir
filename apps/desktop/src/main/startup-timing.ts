// 冷启动的分段计时：进程启动到主进程代码开始执行、app ready、建窗口、首帧（ready-to-show）、页面载完、Host 就绪、
// 渲染进程拿到连接。各段写进同一个对象，首帧与 Host 就绪都到了之后打一行日志，排查“打开慢”时看是哪一段。
// 时间是 performance.now()：Node 的时间原点是进程启动，所以第一个值就是 Electron 自身与加载主进程代码的耗时。
// index.ts 第一个导入这里，让 `mainStart` 记在其他模块求值之前。

export const STARTUP_MARKS = [
  'mainStart',
  'mainEvaluated',
  'appReady',
  'windowCreated',
  'readyToShow',
  'rendererLoaded',
  'hostReady',
  'hostConnection',
] as const;

export type StartupMark = (typeof STARTUP_MARKS)[number];

const marks: Partial<Record<StartupMark, number>> = { mainStart: Math.round(performance.now()) };
let reported = false;

/**
 * 只记第一次（窗口重新加载、Host 重新拉起不算冷启动）。首帧、Host 就绪、渲染进程拿到连接都到了就交给 `report`，只交一次。
 */
export function markStartup(
  mark: StartupMark,
  report: (timings: Partial<Record<StartupMark, number>>) => void,
): void {
  if (marks[mark] !== undefined) return;
  marks[mark] = Math.round(performance.now());
  if (reported || ![marks.readyToShow, marks.hostReady, marks.hostConnection].every(Boolean)) {
    return;
  }
  reported = true;
  report(startupTimings());
}

/** 按发生的先后列出已记下的各段（毫秒，从进程启动算起）。 */
export function startupTimings(): Partial<Record<StartupMark, number>> {
  const result: Partial<Record<StartupMark, number>> = {};
  for (const mark of STARTUP_MARKS) {
    const value = marks[mark];
    if (value !== undefined) result[mark] = value;
  }
  return result;
}
