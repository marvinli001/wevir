/**
 * 有上限的 Map：`get` 与 `set` 都算一次使用，超过 `maxEntries` 项或各项的 `weigh` 加起来超过 `maxWeight` 时，从最久没用的
 * 删起（最新放进去的那一项总是留着）。给“最近一次读到的，换回来时先显示它”这类模块级缓存用，长时间运行内存不再只增不减。
 */
export class LruMap<K, V> extends Map<K, V> {
  readonly #maxEntries: number;
  readonly #maxWeight: number;
  readonly #weigh: (value: V) => number;
  #weight = 0;

  constructor(
    maxEntries: number,
    options: { maxWeight?: number; weigh?: (value: V) => number } = {},
  ) {
    super();
    this.#maxEntries = maxEntries;
    this.#maxWeight = options.maxWeight ?? Number.POSITIVE_INFINITY;
    this.#weigh = options.weigh ?? (() => 0);
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key) as V;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    this.delete(key);
    super.set(key, value);
    this.#weight += this.#weigh(value);
    for (const oldest of super.keys()) {
      if (this.size <= 1 || (this.size <= this.#maxEntries && this.#weight <= this.#maxWeight))
        break;
      this.delete(oldest);
    }
    return this;
  }

  override delete(key: K): boolean {
    if (!super.has(key)) return false;
    this.#weight -= this.#weigh(super.get(key) as V);
    return super.delete(key);
  }

  override clear(): void {
    this.#weight = 0;
    super.clear();
  }
}
