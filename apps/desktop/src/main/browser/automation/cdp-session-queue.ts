// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/cdp-session-queue.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：按 Wevir 的格式重排（Biome）；前一个命令卡住（页面不响应）时最多等 `maxWaitMs` 就轮到下一个，不让一个
// 永远不回答的命令堵死这个标签页之后的所有命令（0.46.0）。

export type CdpCommandSender = (
  command: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

/** 排在后面的命令最多等前一个多久。 */
export const CDP_QUEUE_MAX_WAIT_MS = 10_000;

export class CdpSessionQueue {
  private queue: Promise<void> = Promise.resolve();

  public constructor(private readonly maxWaitMs = CDP_QUEUE_MAX_WAIT_MS) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let releaseCurrent = () => {};
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = Promise.race([
      previous.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.maxWaitMs);
      }),
    ]);
    const tail = ready.then(() => current);
    this.queue = tail;

    await ready;
    clearTimeout(timer);
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (this.queue === tail) {
        this.queue = Promise.resolve();
      }
    }
  }
}
