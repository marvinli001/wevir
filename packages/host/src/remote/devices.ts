import {
  DEFAULT_DEVICE_PERMISSIONS,
  DEVICE_ASSIGNABLE_PERMISSIONS,
  type Device,
  type DeviceId,
  type DevicePlatform,
  type Permission,
} from '@wevir/protocol';
import type { DeviceRecord, SecretStore, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';

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
 * 断开那台设备的连接。
 */
export class DeviceService {
  readonly #storage: Pick<Storage, 'devices'>;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;
  readonly #listeners = new Set<(devices: Device[]) => void>();
  readonly #revokedListeners = new Set<(deviceId: DeviceId) => void>();
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

  /** 移除：状态改 `revoked`、删推送令牌、通知远程监听断开它。已经移除的原样返回。 */
  async revoke(id: DeviceId): Promise<Device> {
    const record = this.#storage.devices.get(id);
    if (!record) throw notFound(id);
    if (record.status === 'revoked') return toDevice(record);
    this.#storage.devices.revoke(id);
    if (record.pushTokenRef !== undefined) await this.#secrets.delete(record.pushTokenRef);
    this.#changed();
    for (const listener of [...this.#revokedListeners]) listener(id);
    return this.#require(id);
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

  /** 设备被移除时调用 `listener`。返回退订函数。 */
  onRevoked(listener: (deviceId: DeviceId) => void): () => void {
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
  };
}

function notFound(id: string): HostError<'DEVICE_NOT_FOUND'> {
  return new HostError('DEVICE_NOT_FOUND', `device ${id} not found`);
}

function invalidParams(path: string[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}
