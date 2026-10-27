// 手机记着的全部电脑与它们的连接：一份记录一个 `ComputerLink`。App 在前台时全部 `resume`，进后台全部 `pause`。存储由
// `ComputerStorage` 注入（真机是 `storage.ts`，测试用内存的）。

import { ComputerLink, type LinkEnvironment, type LinkSnapshot } from './computer-link';
import type { PairingResult } from './pairing';
import type { ComputerRecord } from './records';

export interface ComputerStorage {
  list(): Promise<ComputerRecord[]>;
  save(record: ComputerRecord): Promise<void>;
  remove(name: string): Promise<void>;
  saveKey(routeId: string, secretKey: Uint8Array): Promise<void>;
  deleteKey(routeId: string): Promise<void>;
}

export type RegistryEnvironment = Omit<LinkEnvironment, 'saveRecord'> & {
  /** 退出一台电脑、断开之前（例如请那台电脑解绑推送）；出错不影响退出。 */
  beforeForget?(link: ComputerLink): Promise<void>;
};

export class ComputerRegistry {
  readonly #storage: ComputerStorage;
  readonly #env: LinkEnvironment;
  readonly #beforeForget: RegistryEnvironment['beforeForget'];
  readonly #links = new Map<string, ComputerLink>();
  readonly #unsubscribe = new Map<string, () => void>();
  readonly #listeners = new Set<() => void>();
  #snapshots: readonly LinkSnapshot[] = [];
  #loaded = false;
  #active = false;

  constructor(storage: ComputerStorage, env: RegistryEnvironment) {
    this.#storage = storage;
    const { beforeForget, ...linkEnv } = env;
    this.#env = { ...linkEnv, saveRecord: (record) => storage.save(record) };
    this.#beforeForget = beforeForget;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /** 按配对先后排的全部电脑（引用在有变化时才换，可直接给 `useSyncExternalStore`）。 */
  get snapshots(): readonly LinkSnapshot[] {
    return this.#snapshots;
  }

  link(name: string): ComputerLink | undefined {
    return this.#links.get(name);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async load(): Promise<void> {
    const records = await this.#storage.list();
    for (const record of records) this.#attach(record);
    this.#loaded = true;
    this.#changed();
  }

  /** 前台 / 后台。 */
  setActive(active: boolean): void {
    this.#active = active;
    for (const link of this.#links.values()) {
      if (active) link.resume();
      else link.pause();
    }
  }

  /** 配对成功：先存私钥再存记录；重新配对同一台电脑时换掉旧的连接（名称变了还删掉旧记录）。 */
  async add(result: PairingResult): Promise<void> {
    const { record, device, previous } = result;
    await this.#storage.saveKey(record.routeId, device.secretKey);
    await this.#storage.save(record);
    if (previous !== undefined) {
      this.#detach(previous.name);
      if (previous.name !== record.name) await this.#storage.remove(previous.name);
    }
    this.#detach(record.name);
    this.#attach(record);
    this.#changed();
  }

  /** 退出这台电脑：断开，删记录、私钥与本地缓存。那台电脑上的设备记录不受影响。 */
  async forget(name: string): Promise<void> {
    const link = this.#links.get(name);
    if (link === undefined) return;
    const { routeId } = link.snapshot.record;
    await this.#beforeForget?.(link).catch(() => {});
    if (this.#links.get(name) !== link) return;
    this.#detach(name);
    this.#changed();
    await this.#storage.remove(name);
    await this.#storage.deleteKey(routeId);
    await this.#env.cache?.forget({ routeId });
  }

  #attach(record: ComputerRecord): void {
    const link = new ComputerLink(record, this.#env);
    this.#links.set(record.name, link);
    this.#unsubscribe.set(
      record.name,
      link.subscribe(() => this.#changed()),
    );
    if (this.#active) link.resume();
  }

  #detach(name: string): void {
    this.#unsubscribe.get(name)?.();
    this.#unsubscribe.delete(name);
    this.#links.get(name)?.dispose();
    this.#links.delete(name);
  }

  #changed(): void {
    this.#snapshots = [...this.#links.values()]
      .map((link) => link.snapshot)
      .sort((a, b) =>
        a.record.pairedAt < b.record.pairedAt ? -1 : a.record.pairedAt > b.record.pairedAt ? 1 : 0,
      );
    for (const listener of [...this.#listeners]) listener();
  }
}
