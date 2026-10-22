// 连接配对过的远程电脑：已知的路（上次胜出的地址 + Host 上次给的局域网 / Tailscale 候选地址）与局域网 mDNS 发现到的同一路由 ID 的
// 地址并行做 IK 握手，第一个完成的胜出。每次连上都把胜出的地址与 Host 给的最新候选地址记回文件。中继还没有接上：配对链接里的中继
// 地址只记下，这里不产生 `kind: 'relay'` 的路。

import {
  type ConnectionState,
  directRoute,
  REMOTE_ENDPOINT,
  type RemoteConnectedInfo,
  type RemoteDiscovery,
  type RemoteRoute,
  remoteTransport,
  WevirClient,
} from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { browseWevirHosts } from './mdns.js';
import {
  deviceKeys,
  type RemoteHostRecord,
  type StoredCandidate,
  saveRemoteHost,
} from './store.js';

/** mDNS 等回答多久：与直连的先手相同，找到就立刻加入，不必等满。 */
export const DISCOVERY_MS = 1_500;

/** 一条直连的路，带它的地址（记回文件用）。 */
export interface CandidateRoute extends RemoteRoute {
  readonly candidate: StoredCandidate;
}

export function candidateRoute(candidate: StoredCandidate): CandidateRoute {
  return Object.assign(directRoute(globalThis.WebSocket, candidate), { candidate });
}

/** 已知的路：上次胜出的在前，然后是记下的候选地址。 */
export function knownRoutes(record: RemoteHostRecord): CandidateRoute[] {
  const candidates = [...(record.lastAddress ? [record.lastAddress] : []), ...record.candidates];
  return candidates.map(candidateRoute);
}

/** 局域网 mDNS 里同一路由 ID 的地址。`discover` 选项为假（测试）时不找。 */
export function mdnsDiscovery(routeId: string, browse = browseWevirHosts): RemoteDiscovery {
  return async (add, signal) => {
    await browse({
      timeoutMs: DISCOVERY_MS,
      signal,
      onFound: (host) => {
        if (host.routeId !== routeId) return;
        for (const address of host.addresses) {
          add(candidateRoute({ kind: 'lan', host: address, port: host.port }));
        }
      },
    });
  };
}

export interface RemoteConnectOptions {
  home: string;
  record: RemoteHostRecord;
  identity: ClientIdentity;
  connectMs: number;
  onStateChange?: (state: ConnectionState) => void;
  /** 局域网发现；默认 mDNS。 */
  discover?: RemoteDiscovery | false;
  /** 记回文件的写入，调用方在退出前等它们。 */
  track(write: Promise<unknown>): void;
}

export function connectRemoteHost(options: RemoteConnectOptions): Promise<WevirClient> {
  let record = options.record;
  const discover =
    options.discover === false ? undefined : (options.discover ?? mdnsDiscovery(record.routeId));
  const onConnected = ({ route, host }: RemoteConnectedInfo) => {
    const winner = (route as Partial<CandidateRoute>).candidate;
    record = {
      ...record,
      ...(host.hostName !== undefined && { hostName: host.hostName }),
      candidates: host.candidates.length > 0 ? host.candidates : record.candidates,
      ...(winner !== undefined && { lastAddress: { host: winner.host, port: winner.port } }),
      lastConnectedAt: new Date().toISOString(),
    };
    options.track(saveRemoteHost(options.home, record).catch(() => {}));
  };
  return WevirClient.connect({
    endpoint: REMOTE_ENDPOINT,
    transport: remoteTransport({
      host: { hostPublicKey: record.hostPublicKey, routeId: record.routeId },
      device: deviceKeys(record),
      routes: () => knownRoutes(record),
      ...(discover !== undefined && { discover }),
      onConnected,
    }),
    identity: options.identity,
    timeouts: { connectMs: options.connectMs },
    ...(options.onStateChange && { onStateChange: options.onStateChange }),
  });
}
