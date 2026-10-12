/**
 * 一个会话的事件扇出：每次 `subscribe()` 一个独立队列，只收订阅之后的事件。`end()` 之后已缓冲的
 * 事件照常交付，然后迭代结束；`end()` 之后的 `emit()` 被丢弃。订阅者 `break`（即 `return()`）就退订。
 */
export class EventHub<T> {
  readonly #subscribers = new Set<Subscriber<T>>();
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  emit(event: T): void {
    if (this.#ended) return;
    for (const subscriber of this.#subscribers) subscriber.push(event);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const subscriber of this.#subscribers) subscriber.end();
    this.#subscribers.clear();
  }

  subscribe(): AsyncIterableIterator<T> {
    const subscriber = new Subscriber<T>(() => this.#subscribers.delete(subscriber));
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
