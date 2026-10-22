// 连接配对过的远程电脑：已知的路（上次胜出的地址 + Host 上次给的局域网 / Tailscale 候选地址）与局域网 mDNS 发现到的同一路由 ID 的
// 地址并行做 IK 握手，第一个完成的胜出；那台电脑开了中继时，直连的先手（1.5 s）之后或直连都失败时也经中继试。每次连上都把胜出的
// 路、Host 给的最新候选地址与中继地址记回文件。

import {
  type ConnectionState,
  directRoute,
  REMOTE_ENDPOINT,
  type RemoteConnectedInfo,
  type RemoteDiscovery,
  type RemoteRoute,
  relayRoute,
  remoteTransport,
  WevirClient,
} from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { WebSocket as NodeWebSocket } from 'ws';
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

/**
 * 经中继的路。用 `ws` 包而不是全局 `WebSocket`：只有它报得出升级前被拒的 HTTP 状态码（404 电脑不在中继上、429 限速、503 满了）。
 */
export function cliRelayRoute(relayUrl: string, routeId: string): RemoteRoute {
  return relayRoute(NodeWebSocket, relayUrl, routeId);
}

/** 已知的路：上次胜出的地址在前，然后是记下的候选地址，最后是中继（只用那台电脑给的地址）。 */
export function knownRoutes(record: RemoteHostRecord): RemoteRoute[] {
  const candidates = [...(record.lastAddress ? [record.lastAddress] : []), ...record.candidates];
  return [
    ...candidates.map(candidateRoute),
    ...(record.relayUrl !== undefined ? [cliRelayRoute(record.relayUrl, record.routeId)] : []),
  ];
}

/**
 * 握手负载里的中继地址记回记录：有就用它；没有时只在直连连上时删掉（那台电脑关了中继）。经中继连上时负载总带着地址，这里只防
 * 万一，不因为一次没带就丢掉唯一的退路。
 */
export function nextRelayUrl(
  record: RemoteHostRecord,
  route: RemoteRoute,
  relayUrl: string | undefined,
): string | undefined {
  if (relayUrl !== undefined) return relayUrl;
  return route.kind === 'direct' ? undefined : record.relayUrl;
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
  /** 每次握手成功后：这次走的是直连还是中继。 */
  onRoute?: (kind: RemoteRoute['kind']) => void;
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
    const { relayUrl: _previous, ...rest } = record;
    const relayUrl = nextRelayUrl(record, route, host.relayUrl);
    record = {
      ...rest,
      ...(host.hostName !== undefined && { hostName: host.hostName }),
      candidates: host.candidates.length > 0 ? host.candidates : record.candidates,
      ...(winner !== undefined && { lastAddress: { host: winner.host, port: winner.port } }),
      ...(relayUrl !== undefined && { relayUrl }),
      lastRoute: route.kind,
      lastConnectedAt: new Date().toISOString(),
    };
    options.track(saveRemoteHost(options.home, record).catch(() => {}));
    options.onRoute?.(route.kind);
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
