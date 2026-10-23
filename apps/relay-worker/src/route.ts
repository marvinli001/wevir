import { DurableObject } from 'cloudflare:workers';
import type { Env } from './config.js';

/**
 * 一个路由 ID（一台 Host）的 Durable Object，`idFromName(路由 ID)`：记着现在是哪条控制连接（Control 的 ID）。只存一行，Host 注册与
 * 离线时各写一次；没有 WebSocket，空闲时被驱逐，不占时长。
 *
 * 控制连接本身不在这里：Host 连 `/v1/host` 时还没报上路由 ID（签名注册是连上之后的第一条消息），Worker 只能把它交给一个新的
 * Control，而 Workers 没法把接受了的 WebSocket 挪到另一个 Durable Object。
 */
export class Route extends DurableObject<Env> {
  #control: string | null | undefined;

  /** 现在的控制连接；没有 Host 在线时 null。 */
  async lookup(): Promise<string | null> {
    this.#control ??= (await this.ctx.storage.get<string>('control')) ?? null;
    return this.#control;
  }

  /** 新的控制连接注册成功：取代旧的，旧的以 `ROUTE_REPLACED` 关闭。 */
  async register(control: string): Promise<void> {
    await this.lookup();
    // 读旧值与写新值之间不让出：两条控制连接同时注册时，后一条取代的是前一条。
    const previous = this.#control ?? null;
    this.#control = control;
    await this.ctx.storage.put('control', control);
    if (previous === null || previous === control) return;
    try {
      await this.env.CONTROLS.get(this.env.CONTROLS.idFromString(previous)).replaced();
    } catch {
      // 旧的已经不在了。
    }
  }

  /** 控制连接断开：还是它的话路由消失。 */
  async unregister(control: string): Promise<void> {
    if ((await this.lookup()) !== control) return;
    this.#control = null;
    await this.ctx.storage.delete('control');
  }
}
