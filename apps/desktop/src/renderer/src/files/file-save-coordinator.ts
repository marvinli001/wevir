// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/files/fileSaveCoordinator.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：`persist` 回布尔值（T3 是 Effect atom 的 AtomCommandResult），其余照搬。
//
// 文件窗格的自动保存（0.32.0）：编辑停下 `debounceMs` 后写回最新的内容；写的时候又改了就等这次写完再写一次；关掉窗格时把
// 还没写的写掉。冲突（磁盘上的文件变了）由 `persist` 自己处理，回 false 时这一版不算确认，等下一次编辑。

export interface FileSaveCoordinatorOptions {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  /** 写回；true 是写成了。 */
  readonly persist: (contents: string) => Promise<boolean>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | undefined;
}

export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = '';
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;

  constructor(private readonly options: FileSaveCoordinatorOptions) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;
    if (this.options.canPersist?.() === false) {
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const succeeded = await this.options.persist(contents).catch(() => false);
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
