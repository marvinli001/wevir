import { type AgentEvent, EventHub, type EventHubOptions } from '@wevir/runtime-adapter';

/** 命令输出的合并窗口：同一个工具只带输出的 `tool.updated` 在这段时间里只发最新的一条。 */
export const OUTPUT_WINDOW_MS = 100;

type ToolUpdated = Extract<AgentEvent, { type: 'tool.updated' }>;

/** 只更新输出的 `tool.updated`（命令的 outputDelta、MCP 的进度）：每条都带到目前为止的全部输出。 */
function outputOnly(event: AgentEvent): event is ToolUpdated {
  return (
    event.type === 'tool.updated' &&
    event.output !== undefined &&
    event.display === undefined &&
    event.input === undefined
  );
}

/**
 * 会话的事件扇出，合并命令输出：Codex 每个 outputDelta 都映射成一条带全部输出的 `tool.updated`，输出多的命令（安装、构建日志）
 * 每一小段都让 Host 截断、写库一次，代价随输出量平方增长。同一个工具在 `OUTPUT_WINDOW_MS` 里只发第一条与窗口末尾最新的一条；
 * 别的事件发出之前先把攒着的发掉，顺序不变，命令结束、回合结束时输出都已经是最新的。
 */
export class OutputHub extends EventHub<AgentEvent> {
  readonly #windowMs: number;
  /** 攒着还没发的输出：toolCallId → 最新的一条。 */
  readonly #pending = new Map<string, ToolUpdated>();
  /** 每个工具上一次发出输出的时刻。 */
  readonly #sentAt = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: EventHubOptions & { windowMs?: number } = {}) {
    super(options);
    this.#windowMs = options.windowMs ?? OUTPUT_WINDOW_MS;
  }

  override emit(event: AgentEvent): void {
    if (outputOnly(event)) {
      const id = event.toolCallId;
      const sentAt = this.#sentAt.get(id);
      const now = Date.now();
      if (!this.#pending.has(id) && (sentAt === undefined || now - sentAt >= this.#windowMs)) {
        this.#sentAt.set(id, now);
        super.emit(event);
        return;
      }
      this.#pending.set(id, event);
      if (this.#timer === undefined) {
        this.#timer = setTimeout(() => this.flush(), this.#windowMs);
        this.#timer.unref?.();
      }
      return;
    }
    this.flush();
    if (event.type === 'tool.finished') this.#sentAt.delete(event.toolCallId);
    if (event.type === 'turn.settled' || event.type === 'turn.failed') this.#sentAt.clear();
    super.emit(event);
  }

  /** 发出攒着的输出。 */
  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pending.size === 0) return;
    const now = Date.now();
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const event of pending) {
      this.#sentAt.set(event.toolCallId, now);
      super.emit(event);
    }
  }

  override end(): void {
    this.flush();
    this.#sentAt.clear();
    super.end();
  }
}
