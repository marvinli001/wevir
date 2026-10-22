import { createHash } from 'node:crypto';
import { REMOTE_MDNS_SERVICE_TYPE, REMOTE_MDNS_TXT_VERSION } from '@wevir/protocol';
import type { RemoteKeys } from './identity.js';
import type { RemoteAddress } from './network.js';

/** 局域网里广播的内容（`_wevir._tcp`）。 */
export interface MdnsAnnouncement {
  /** 实例名：Host 的路由 ID。 */
  readonly name: string;
  readonly type: string;
  readonly port: number;
  /** `<hostname>.local`：由路由 ID 派生，不含电脑名。 */
  readonly hostname: string;
  readonly txt: Readonly<Record<string, string>>;
  /** A / AAAA 记录只给这些地址（勾选的局域网地址）；不给就会连回环与链路本地地址一起广播。 */
  readonly restrictedAddresses: readonly string[];
  /** 只在这些网卡上收发 mDNS。 */
  readonly interfaces: readonly string[];
  readonly ipv6: boolean;
}

/**
 * 要广播的内容；没有在监听的局域网地址时 undefined（不广播）。Tailscale 地址不广播：tailnet 里没有组播，手机经 Tailscale 用配对时
 * 拿到的地址或 MagicDNS 名。
 */
export function mdnsAnnouncement(
  keys: Pick<RemoteKeys, 'routeId' | 'hostPublicKey'>,
  port: number,
  listening: readonly RemoteAddress[],
): MdnsAnnouncement | undefined {
  const lan = listening.filter((address) => address.kind === 'lan');
  if (lan.length === 0) return undefined;
  const { routeId } = keys;
  return {
    name: routeId,
    type: REMOTE_MDNS_SERVICE_TYPE,
    port,
    hostname: `wevir-${createHash('sha256').update(routeId).digest('hex').slice(0, 16)}`,
    // `pk` 是 Host 的 Noise 静态公钥：只拿到短码的设备要用它派生 PSK、拼 prologue。冒充的 Host 不知道短码，握手照样完不成。
    txt: { v: REMOTE_MDNS_TXT_VERSION, rid: routeId, pk: keys.hostPublicKey },
    restrictedAddresses: lan.map((address) => address.address),
    interfaces: [...new Set(lan.map((address) => address.name))],
    ipv6: lan.some((address) => address.family === 'IPv6'),
  };
}

/** 广播的执行者。内容变了就换；`undefined` 是停掉。 */
export interface MdnsAdvertiser {
  update(announcement: MdnsAnnouncement | undefined): void;
  /** 停掉并发告别包（远程关掉、Host 退出）。 */
  shutdown(): Promise<void>;
}

/** 用 `@homebridge/ciao` 广播（纯 TS；`bonjour-service` 会把电脑名写进 SRV，不用它）。按需加载，远程关着时不加载。 */
export function createCiaoAdvertiser(onError: (error: unknown) => void): MdnsAdvertiser {
  let current: { key: string; stop: () => Promise<void> } | undefined;
  let queue: Promise<void> = Promise.resolve();
  const run = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(onError);
    return queue;
  };
  const stop = async () => {
    const running = current;
    current = undefined;
    await running?.stop();
  };
  return {
    update(announcement) {
      const key = announcement === undefined ? '' : JSON.stringify(announcement);
      if ((current?.key ?? '') === key) return;
      void run(async () => {
        if ((current?.key ?? '') === key) return;
        await stop();
        if (announcement === undefined) return;
        const { getResponder } = await import('@homebridge/ciao');
        const responder = getResponder({
          interface: [...announcement.interfaces],
          advertiseIpv6: announcement.ipv6,
          disableIpv6: !announcement.ipv6,
        });
        const service = responder.createService({
          name: announcement.name,
          type: announcement.type,
          port: announcement.port,
          hostname: announcement.hostname,
          txt: { ...announcement.txt },
          restrictedAddresses: [...announcement.restrictedAddresses],
          disabledIpv6: !announcement.ipv6,
        });
        current = {
          key,
          stop: async () => {
            await service.destroy().catch(onError);
            await responder.shutdown();
          },
        };
        await service.advertise();
      });
    },
    shutdown: () => run(stop),
  };
}
