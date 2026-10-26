/**
 * 同时最多跑 `max` 个任务，多出来的按到达顺序排队。用在一次要读很多文件的地方（skill 目录），既能同时读，又不至于开太多文件
 * 句柄（macOS 默认软上限 256，超了 `EMFILE` 会被当成读不了）。
 */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    running -= 1;
    queue.shift()?.();
  };
  return (task) =>
    new Promise((resolve, reject) => {
      const run = () => {
        running += 1;
        task().then(resolve, reject).finally(next);
      };
      if (running < max) run();
      else queue.push(run);
    });
}
