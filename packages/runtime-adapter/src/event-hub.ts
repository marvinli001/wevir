export interface EventHubOptions {
  /**
   * 在第一个订阅者到来之前发出的事件先存着，交给第一个订阅者（之后的订阅者照常只收订阅之后的）。子会话用：引擎先于
   * Host 的订阅发出子会话的事件（R4，events.ts 的顺序约定）。
   */
  bufferUntilSubscribed?: boolean;
}

/**
 * 一个会话的事件扇出：每次 `subscribe()` 一个独立队列，只收订阅之后的事件（`bufferUntilSubscribed` 时第一个
 * 订阅者另外收到之前存下的）。`end()` 之后已缓冲的事件照常交付，然后迭代结束；`end()` 之后的 `emit()` 被丢弃。
 * 订阅者 `break`（即 `return()`）就退订。
 */
export class EventHub<T> {
  readonly #subscribers = new Set<Subscriber<T>>();
  /** 第一个订阅者到来之前存下的事件；有过订阅者之后为 undefined。 */
  #early: T[] | undefined;
  #ended = false;

  constructor(options: EventHubOptions = {}) {
    if (options.bufferUntilSubscribed) this.#early = [];
  }

  get ended(): boolean {
    return this.#ended;
  }

  emit(event: T): void {
    if (this.#ended) return;
    if (this.#early !== undefined) {
      this.#early.push(event);
      return;
    }
    for (const subscriber of this.#subscribers) subscriber.push(event);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    // 没有订阅者就结束了：存下的事件留给之后的第一个订阅者（它随即看到结束）。
    for (const subscriber of this.#subscribers) subscriber.end();
    this.#subscribers.clear();
  }

  subscribe(): AsyncIterableIterator<T> {
    const subscriber = new Subscriber<T>(() => this.#subscribers.delete(subscriber));
    const early = this.#early;
    this.#early = undefined;
    for (const event of early ?? []) subscriber.push(event);
    if (this.#ended) subscriber.end();
    else this.#subscribers.add(subscriber);
    return subscriber;
  }
}

class Subscriber<T> implements AsyncIterableIterator<T> {
  readonly #buffer: T[] = [];
  readonly #onReturn: () => void;
  #waiter: ((result: IteratorResult<T>) => void) | undefined;
  #ended = false;

  constructor(onReturn: () => void) {
    this.#onReturn = onReturn;
  }

  push(event: T): void {
    if (this.#ended) return;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ value: event, done: false });
    } else {
      this.#buffer.push(event);
    }
  }

  end(): void {
    this.#ended = true;
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) {
      return Promise.resolve({ value: this.#buffer.shift() as T, done: false });
    }
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.#buffer.length = 0;
    this.end();
    this.#onReturn();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
