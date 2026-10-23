import {
  DEFAULT_DEVICE_PERMISSIONS,
  DEVICE_ASSIGNABLE_PERMISSIONS,
  type Device,
  type DeviceId,
  type DevicePlatform,
  type Permission,
  type PushPlatform,
  PushPlatformSchema,
  PushTokenSchema,
} from '@wevir/protocol';
import type { DeviceRecord, SecretStore, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';

/** secrets.json 里一台设备的推送令牌（0.112.0）。 */
export interface StoredPushToken {
  platform: PushPlatform;
  token: string;
}

/** 移除设备时交给 `onRevoked` 监听者的：删掉之前的推送令牌（推送服务据此向网关解绑）。 */
export interface RevokedDevice {
  pushToken?: StoredPushToken;
}

/** 配对握手里设备报上来的自己。 */
export interface DeviceIdentity {
  name: string;
  platform: DevicePlatform;
  /** Noise 静态公钥，base64url。 */
  publicKey: string;
}

/**
 * 配对过的远程设备（domain-model §3.49，ADR-0017 §3–§4）：增（配对允许后）、改名称与权限、移除。变了就把全部设备交给 `watch` 的
 * 监听者（`devices.changed`）；移除时另外通知 `onRevoked` 的监听者、改了权限时通知 `onPermissionsChanged` 的监听者，远程监听据此立即
 * 断开那台设备的连接。推送（0.112.0）的开关、计数与令牌也在这里：令牌加密存在 `SecretStore`（secrets.json），库里只有条目名。
 */
export class DeviceService {
  readonly #storage: Pick<Storage, 'devices'>;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;
  readonly #listeners = new Set<(devices: Device[]) => void>();
  readonly #revokedListeners = new Set<(deviceId: DeviceId, removed: RevokedDevice) => void>();
  readonly #permissionListeners = new Set<(deviceId: DeviceId) => void>();

  constructor(options: {
    storage: Pick<Storage, 'devices'>;
    secrets: SecretStore;
    now?: () => Date;
  }) {
    this.#storage = options.storage;
    this.#secrets = options.secrets;
    this.#now = options.now ?? (() => new Date());
  }

  list(): Device[] {
    return this.#storage.devices.list().map(toDevice);
  }

  get(id: DeviceId): Device | undefined {
    const record = this.#storage.devices.get(id);
    return record && toDevice(record);
  }

  /** 这个公钥的 active 设备（`IK` 握手认设备用）。 */
  findActive(publicKey: string): Device | undefined {
    const record = this.#storage.devices.findActive(publicKey);
    return record && toDevice(record);
  }

  /**
   * 配对允许后写入。同一个公钥已有 active 的设备时是重新配对：更新名称与平台，保留 ID 与权限。新设备的权限是
   * `DEFAULT_DEVICE_PERMISSIONS`。
   */
  add(identity: DeviceIdentity): Device {
    const at = this.#now().toISOString();
    const existing = this.#storage.devices.findActive(identity.publicKey);
    let id: DeviceId;
    if (existing) {
      id = existing.id as DeviceId;
      this.#storage.devices.update(id, {
        name: identity.name,
        platform: identity.platform,
        lastSeenAt: at,
      });
    } else {
      id = newId('dev');
      this.#storage.devices.insert({
        id,
        name: identity.name,
        platform: identity.platform,
        publicKey: identity.publicKey,
        permissions: [...DEFAULT_DEVICE_PERMISSIONS],
        createdAt: at,
        lastSeenAt: at,
        status: 'active',
        pushEnabled: false,
        pushCounter: 0,
      });
    }
    this.#changed();
    return this.#require(id);
  }

  /** 改名称或整组权限。已移除的设备不能改（`INVALID_PARAMS`）；权限只能取 `DEVICE_ASSIGNABLE_PERMISSIONS` 里的。 */
  update(params: { id: DeviceId; name?: string; permissions?: string[] }): Device {
    const device = this.#require(params.id);
    if (device.status === 'revoked') {
      throw invalidParams(['id'], 'the device has been removed');
    }
    let permissions: Permission[] | undefined;
    if (params.permissions !== undefined) {
      const assignable = new Set<string>(DEVICE_ASSIGNABLE_PERMISSIONS);
      const unknown = params.permissions.find((permission) => !assignable.has(permission));
      if (unknown !== undefined) {
        throw invalidParams(['permissions'], `permission ${unknown} cannot be granted to a device`);
      }
      // 去重，按词表的顺序存。
      const wanted = new Set(params.permissions);
      permissions = DEVICE_ASSIGNABLE_PERMISSIONS.filter((permission) => wanted.has(permission));
    }
    this.#storage.devices.update(params.id, {
      ...(params.name !== undefined && { name: params.name }),
      ...(permissions !== undefined && { permissions }),
    });
    this.#changed();
    const changed =
      permissions !== undefined && permissions.join(' ') !== device.permissions.join(' ');
    if (changed) for (const listener of [...this.#permissionListeners]) listener(params.id);
    return this.#require(params.id);
  }

  /** 移除：状态改 `revoked`、删推送令牌、通知远程监听断开它与推送服务解绑。已经移除的原样返回。 */
  async revoke(id: DeviceId): Promise<Device> {
    const record = this.#storage.devices.get(id);
    if (!record) throw notFound(id);
    if (record.status === 'revoked') return toDevice(record);
    const pushToken = await this.pushToken(id);
    this.#storage.devices.revoke(id);
    if (record.pushTokenRef !== undefined) await this.#secrets.delete(record.pushTokenRef);
    this.#changed();
    const removed: RevokedDevice = pushToken !== undefined ? { pushToken } : {};
    for (const listener of [...this.#revokedListeners]) listener(id, removed);
    return this.#require(id);
  }

  /** 这台设备的推送令牌（0.112.0）。没有或读不懂时 undefined。 */
  async pushToken(id: DeviceId): Promise<StoredPushToken | undefined> {
    const ref = this.#storage.devices.get(id)?.pushTokenRef;
    if (ref === undefined) return undefined;
    const stored = await this.#secrets.get(ref);
    if (stored === undefined) return undefined;
    try {
      const value = JSON.parse(stored) as { platform?: unknown; token?: unknown };
      const platform = PushPlatformSchema.safeParse(value.platform);
      const token = PushTokenSchema.safeParse(value.token);
      return platform.success && token.success
        ? { platform: platform.data, token: token.data }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 存下（或 `undefined` 时删掉）这台设备的推送令牌，发 `devices.changed`。已移除的设备不能存。 */
  async setPushToken(id: DeviceId, token: StoredPushToken | undefined): Promise<void> {
    const record = this.#storage.devices.get(id);
    if (!record) throw notFound(id);
    if (token !== undefined) {
      if (record.status !== 'active') throw invalidParams(['id'], 'the device has been removed');
      const ref = pushTokenRef(id);
      await this.#secrets.set(ref, JSON.stringify(token));
      this.#storage.devices.update(id, { pushTokenRef: ref });
    } else {
      if (record.pushTokenRef === undefined) return;
      await this.#secrets.delete(record.pushTokenRef);
      this.#storage.devices.update(id, { pushTokenRef: null });
    }
    this.#changed();
  }

  /** 这台设备的推送开关（0.112.0）。没变时什么都不做。 */
  setPushEnabled(id: DeviceId, enabled: boolean): void {
    const record = this.#storage.devices.get(id);
    if (!record) throw notFound(id);
    if (record.status !== 'active') throw invalidParams(['id'], 'the device has been removed');
    if (record.pushEnabled === enabled) return;
    this.#storage.devices.update(id, { pushEnabled: enabled });
    this.#changed();
  }

  /**
   * 给这台设备加密下一条推送用的计数：`max(上一次 + 1, now)`，先写库再返回。取毫秒时间戳作下限，库被从备份恢复、计数倒退时也不会
   * 与之前用过的重复。
   */
  nextPushCounter(id: DeviceId, now: number): number {
    const record = this.#storage.devices.get(id);
    if (!record) throw notFound(id);
    const counter = Math.max(record.pushCounter + 1, Math.floor(now));
    this.#storage.devices.update(id, { pushCounter: counter });
    return counter;
  }

  /** 记下最近在线（远程连接握手成功、连接还在时）。不发 `devices.changed`。 */
  touch(id: DeviceId): void {
    this.#storage.devices.update(id, { lastSeenAt: this.#now().toISOString() });
  }

  /** 设备变了时调用 `listener`（带全部设备）。返回退订函数。 */
  watch(listener: (devices: Device[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 设备的权限改了时调用 `listener`（0.109.0）。连接的权限在 hello 时定下，远程监听据此断开那台设备的连接，让它重连后按新的权限
   * 工作。返回退订函数。
   */
  onPermissionsChanged(listener: (deviceId: DeviceId) => void): () => void {
    this.#permissionListeners.add(listener);
    return () => this.#permissionListeners.delete(listener);
  }

  /** 设备被移除时调用 `listener`（带删掉之前的推送令牌）。返回退订函数。 */
  onRevoked(listener: (deviceId: DeviceId, removed: RevokedDevice) => void): () => void {
    this.#revokedListeners.add(listener);
    return () => this.#revokedListeners.delete(listener);
  }

  #require(id: DeviceId): Device {
    const device = this.get(id);
    if (!device) throw notFound(id);
    return device;
  }

  #changed(): void {
    if (this.#listeners.size === 0) return;
    const devices = this.list();
    for (const listener of [...this.#listeners]) listener(devices);
  }
}

function toDevice(record: DeviceRecord): Device {
  return {
    id: record.id as DeviceId,
    name: record.name,
    platform: record.platform as DevicePlatform,
    publicKey: record.publicKey,
    permissions: record.permissions,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    status: record.status as Device['status'],
    push: { enabled: record.pushEnabled, registered: record.pushTokenRef !== undefined },
  };
}

/** secrets.json 里这台设备的推送令牌的条目名。名字带点，不会与 Provider ID 相撞。 */
function pushTokenRef(id: DeviceId): string {
  return `device.${id}.push`;
}

function notFound(id: string): HostError<'DEVICE_NOT_FOUND'> {
  return new HostError('DEVICE_NOT_FOUND', `device ${id} not found`);
}

function invalidParams(path: string[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}
