// 在场（0.104.0，Host 功能 `notification_intents`，domain-model §3.48）：每条连接最近一次 `presence.update` 报的值；任一本机连接在场即
// “有人在电脑前”。聚合只在 Host 内部用（以后的手机推送据此决定发不发），没有查询方法。

/** 一条连接在 Presence 里的键：连接对象本身。 */
export type PresenceKey = object;

export class Presence {
  /** 报过在场的连接：值是它报的 active 与它是不是本机连接。 */
  readonly #reports = new Map<PresenceKey, { active: boolean; local: boolean }>();
  readonly #listeners = new Set<(atComputer: boolean) => void>();
  #atComputer = false;

  /** 这条连接报了一次在场。远程连接的值只记下，不算进“有人在电脑前”。 */
  update(key: PresenceKey, active: boolean, local: boolean): void {
    this.#reports.set(key, { active, local });
    this.#recompute();
  }

  /** 连接关闭：忘掉它报过的值。 */
  remove(key: PresenceKey): void {
    if (this.#reports.delete(key)) this.#recompute();
  }

  /** 有没有本机连接在场。 */
  atComputer(): boolean {
    return this.#atComputer;
  }

  /** 这条连接最近一次报的值；没报过（或已关闭）时 undefined。 */
  activeOf(key: PresenceKey): boolean | undefined {
    return this.#reports.get(key)?.active;
  }

  /** `atComputer()` 变了时调用 `listener`。返回取消函数。 */
  watch(listener: (atComputer: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #recompute(): void {
    let atComputer = false;
    for (const report of this.#reports.values()) {
      if (report.local && report.active) {
        atComputer = true;
        break;
      }
    }
    if (atComputer === this.#atComputer) return;
    this.#atComputer = atComputer;
    for (const listener of [...this.#listeners]) listener(atComputer);
  }
}
