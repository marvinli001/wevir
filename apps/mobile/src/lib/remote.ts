// 手机端到 Host 的网络：直连与中继的路、配对与重连。全部用 client-sdk 的 `remoteTransport` / `pairRemoteHost`（不在手机端重写
// 协议与 Noise）；WebSocket 用 React Native 自带的（由调用方传入，测试用 `ws`）。不用 `fetch` 访问 Host（iOS 的 ATS 会拦 `100.x`）。

import {
  type BinaryWebSocketConstructor,
  type BinaryWebSocketLike,
  directRoute,
  pairRemoteHost,
  REMOTE_ENDPOINT,
  type RemoteDiscovery,
  type RemoteRoute,
  relayRoute,
  remoteTransport,
  WevirClient,
} from '@wevir/client-sdk';
import type { KeyPair } from '@wevir/noise';
import { type ClientIdentity, type DevicePlatform, REMOTE_NATIVE_ORIGIN } from '@wevir/protocol';
import type { ChannelClient } from './bot-store';
import type { ChangesClient } from './changes';
import type { LinkClient, LinkEnvironment } from './computer-link';
import type { InboxClient } from './inbox-store';
import type { NewSessionClient } from './new-session';
import {
  type BrowseOptions,
  type DiscoveredHost,
  discoveredCandidates,
  type PairingEnvironment,
} from './pairing';
import type { PushLinkClient } from './push';
import { type ComputerRecord, knownCandidates, type StoredCandidate } from './records';

/** mDNS 找回换了地址的电脑等多久：与直连的先手相同，找到就立刻加入（同 CLI）。 */
export const CONNECT_DISCOVERY_MS = 1_500;
/** 一次连接尝试（含握手与 `host.hello`）的时限。 */
export const CONNECT_TIMEOUT_MS = 15_000;

/** React Native 的 WebSocket 构造：第三个参数里的 `headers` 会加进升级请求。 */
export type NativeWebSocketConstructor = new (
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
) => BinaryWebSocketLike;

/**
 * 换掉 `Origin` 的 WebSocket：React Native 在 iOS 与 Android 上都会按地址补一个 `http://…` 的 `Origin`，Host 的远程监听把带
 * 网页来源的升级一律拒掉（403），所以改成原生应用的固定值。
 */
export function withNativeOrigin(
  WebSocketImpl: NativeWebSocketConstructor,
): BinaryWebSocketConstructor {
  return class extends WebSocketImpl {
    constructor(url: string) {
      super(url, undefined, { headers: { origin: REMOTE_NATIVE_ORIGIN } });
    }
  };
}

export type Browse = (options: BrowseOptions) => Promise<DiscoveredHost[]>;

/** 一条直连的路，带它的地址（记回记录用）。 */
interface CandidateRoute extends RemoteRoute {
  readonly candidate: StoredCandidate;
}

function candidateRoute(
  WebSocketImpl: BinaryWebSocketConstructor,
  candidate: StoredCandidate,
): CandidateRoute {
  return Object.assign(directRoute(WebSocketImpl, candidate), { candidate });
}

function winnerAddress(route: RemoteRoute): { host: string; port: number } | undefined {
  const candidate = (route as Partial<CandidateRoute>).candidate;
  return candidate === undefined ? undefined : { host: candidate.host, port: candidate.port };
}

/** 已知的路：上次胜出的地址在前，然后是记下的候选地址，最后是中继（只用那台电脑给的地址）。 */
export function knownRoutes(
  WebSocketImpl: BinaryWebSocketConstructor,
  record: Pick<ComputerRecord, 'candidates' | 'lastAddress' | 'relayUrl' | 'routeId'>,
): RemoteRoute[] {
  return [
    ...knownCandidates(record).map((c) => candidateRoute(WebSocketImpl, c)),
    ...(record.relayUrl !== undefined
      ? [relayRoute(WebSocketImpl, record.relayUrl, record.routeId)]
      : []),
  ];
}

/** 局域网 mDNS 里同一路由 ID 的地址。 */
export function mdnsDiscovery(
  WebSocketImpl: BinaryWebSocketConstructor,
  browse: Browse,
  routeId: string,
  timeoutMs = CONNECT_DISCOVERY_MS,
): RemoteDiscovery {
  return async (add, signal) => {
    await browse({
      timeoutMs,
      signal,
      onFound: (host) => {
        if (host.routeId !== routeId) return;
        for (const candidate of discoveredCandidates(host))
          add(candidateRoute(WebSocketImpl, candidate));
      },
    });
  };
}

export interface RemoteDeps {
  WebSocket: BinaryWebSocketConstructor;
  browse: Browse;
  identity(): Promise<ClientIdentity>;
}

/** 配对用的 `PairingEnvironment.pair`。 */
export function remotePair(
  deps: RemoteDeps,
  device: { name: string; platform: DevicePlatform },
): PairingEnvironment['pair'] {
  return async (attempt) => {
    const { target } = attempt;
    const routes: RemoteRoute[] = [
      ...target.candidates.map((c) => candidateRoute(deps.WebSocket, c)),
      ...(target.relayUrl !== undefined
        ? [relayRoute(deps.WebSocket, target.relayUrl, target.routeId)]
        : []),
    ];
    const result = await pairRemoteHost({
      host: { hostPublicKey: target.hostPublicKey, routeId: target.routeId },
      device: attempt.device,
      secret: attempt.secret,
      routes,
      ...(attempt.rediscover && {
        discover: mdnsDiscovery(deps.WebSocket, deps.browse, target.routeId),
      }),
      name: device.name,
      platform: device.platform,
      identity: await deps.identity(),
      onAwaitingApproval: ({ host }) => attempt.onAwaitingApproval(host),
      signal: attempt.signal,
    });
    const address = winnerAddress(result.route);
    return {
      route: result.route.kind,
      ...(address !== undefined && { address }),
      host: result.host,
    };
  };
}

/** 重连用的 `LinkEnvironment.connect`：设备私钥按记录从钥匙串取。 */
export function remoteConnect(
  deps: RemoteDeps,
  deviceKey: (record: ComputerRecord) => Promise<KeyPair>,
): LinkEnvironment['connect'] {
  return async (hooks) => {
    const record = hooks.record();
    const device = await deviceKey(record);
    const identity = await deps.identity();
    const client = await WevirClient.connect({
      endpoint: REMOTE_ENDPOINT,
      transport: remoteTransport({
        host: { hostPublicKey: record.hostPublicKey, routeId: record.routeId },
        device,
        routes: () => knownRoutes(deps.WebSocket, hooks.record()),
        discover: mdnsDiscovery(deps.WebSocket, deps.browse, record.routeId),
        onConnected: ({ route, host }) => {
          const address = winnerAddress(route);
          hooks.onConnected({ route: route.kind, ...(address !== undefined && { address }), host });
        },
      }),
      identity,
      timeouts: { connectMs: CONNECT_TIMEOUT_MS },
      onStateChange: hooks.onStateChange,
    });
    return wrapClient(client, identity);
  };
}

function wrapClient(client: WevirClient, identity: ClientIdentity): LinkClient {
  const channels: ChannelClient | undefined =
    client.supports('channels') && client.can('session.read')
      ? {
          // 权限可能在重连时变（电脑上改了这台设备的权限）。
          get canCreate() {
            return client.can('workspace.write') && client.can('provider.read');
          },
          get canEdit() {
            return client.can('workspace.write');
          },
          get canReadProviders() {
            return client.can('provider.read');
          },
          get engineFeatures() {
            return client.hello.engineFeatures;
          },
          get composer() {
            return client.supports('channel_composer') && client.can('session.write');
          },
          get speech() {
            return client.supports('speech') && client.can('session.write');
          },
          get canReadProjects() {
            return client.can('workspace.read');
          },
          get groups() {
            return client.supports('channel_groups');
          },
          request: (method, ...args) => client.request(method, ...args),
          onChannelsChanged: (listener) => client.onChannelsChanged(listener),
          watchChannel: (channelId, handlers, options) =>
            client.watchChannel(channelId, handlers, options),
        }
      : undefined;
  const sessions: NewSessionClient | undefined = client.can('session.read')
    ? {
        get canWrite() {
          return client.can('session.write');
        },
        get canReadProviders() {
          return client.can('provider.read');
        },
        supports: (feature) => client.supports(feature),
        request: (method, ...args) => client.request(method, ...args),
        subscribe: (sessionId, options) => client.subscribe(sessionId, options),
      }
    : undefined;
  const push: PushLinkClient | undefined =
    client.supports('remote_push') && client.can('session.read')
      ? {
          get: () => client.request('push.get', {}),
          register: (params) => client.request('push.register', params),
          unregister: () => client.request('push.unregister', {}),
          onChanged: (listener) => client.onPushChanged(listener),
        }
      : undefined;
  const inbox: InboxClient | undefined =
    client.supports('inbox') && client.can('session.read')
      ? {
          get canWrite() {
            return client.can('session.write');
          },
          identity,
          listInbox: () => client.request('inbox.list', {}),
          onInboxChanged: (listener) => client.onInboxChanged(listener),
          request: (method, ...args) => client.request(method, ...args),
        }
      : undefined;
  const changes: ChangesClient = {
    get canRead() {
      return client.can('workspace.read');
    },
    get supportsDiff() {
      return client.supports('workspace_diff');
    },
    get supportsFiles() {
      return client.supports('files_read');
    },
    request: (method, ...args) => client.request(method, ...args),
  };
  return {
    changes,
    ...(channels !== undefined && { channels }),
    ...(sessions !== undefined && { sessions }),
    ...(push !== undefined && { push }),
    ...(inbox !== undefined && { inbox }),
    watchNotifications: (listener) => client.watchNotifications(listener),
    onStateChange: (listener) => client.onStateChange(listener),
    onSessionsChanged: (listener) => client.onSessionsChanged(listener),
    listSessions: async () => {
      const result = await client.request('session.list', {});
      return { sessions: result.sessions, listVersion: result.listVersion };
    },
    close: () => client.close(),
  };
}
