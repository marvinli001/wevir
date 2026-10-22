import { hostname } from 'node:os';
import {
  pairRemoteHost,
  type RemotePairingResult,
  type RemoteRoute,
  RemoteUnreachableError,
} from '@wevir/client-sdk';
import { generateKeyPair } from '@wevir/noise';
import {
  DEVICE_NAME_MAX_LENGTH,
  type DevicePlatform,
  normalizePairingCode,
  PAIRING_URI_PREFIX,
  type PairingPayload,
  parsePairingUri,
} from '@wevir/protocol';
import type { Context } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, table } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import {
  type CandidateRoute,
  candidateRoute,
  cliRelayRoute,
  DISCOVERY_MS,
} from '../remote/connect.js';
import { browseWevirHosts, type DiscoveredHost } from '../remote/mdns.js';
import {
  encodeSecretKey,
  listRemoteHosts,
  REMOTE_NAME_PATTERN,
  type RemoteHostRecord,
  removeRemoteHost,
  type StoredCandidate,
  saveRemoteHost,
  slugifyHostName,
  uniqueName,
} from '../remote/store.js';

export interface RemotePairOptions {
  /** 记下的名称（`--remote <名称>`）；默认由电脑名称推出。 */
  name?: string;
  /** 电脑上显示的这台设备的名称；默认本机主机名。 */
  deviceName?: string;
}

/** 短码配对时，局域网里第一台电脑回答之后再等多久。 */
const DISCOVERY_GRACE_MS = 300;

/** 这台设备报给电脑的平台。 */
function devicePlatform(): DevicePlatform {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    default:
      return 'other';
  }
}

function defaultDeviceName(): string {
  const name = hostname()
    .replace(/\.local$/i, '')
    .trim();
  return (name === '' ? 'Wevir CLI' : name).slice(0, DEVICE_NAME_MAX_LENGTH);
}

/** 要配对的一台电脑：身份、配对秘密与能试的路。 */
interface PairingTarget {
  hostPublicKey: string;
  routeId: string;
  hostName?: string;
  /** 直连的路。 */
  routes: CandidateRoute[];
  /** 配对链接里的中继地址：直连的先手之后也经它试。 */
  relayUrl?: string;
}

function pairingRoutes(target: PairingTarget): RemoteRoute[] {
  return [
    ...target.routes,
    ...(target.relayUrl !== undefined ? [cliRelayRoute(target.relayUrl, target.routeId)] : []),
  ];
}

/**
 * `wevir remote pair <配对链接或短码>`：配对链接（桌面“添加设备”二维码的内容）自带 Host 公钥、路由 ID、地址与（开了中继时的）
 * 中继地址；短码要在局域网里用 mDNS 找到广播 `pk` 的电脑，经中继配对不了（没有路由 ID 与 Host 公钥）。握手之后等电脑上点“允许”，
 * 允许了把这台电脑记下。
 */
export async function remotePair(
  ctx: Context,
  input: string,
  options: RemotePairOptions,
): Promise<number> {
  if (options.name !== undefined && !REMOTE_NAME_PATTERN.test(options.name)) {
    throw new UsageError(t('remote.badName', { name: options.name }));
  }
  const deviceName = (options.deviceName ?? defaultDeviceName()).trim();
  if (deviceName === '' || deviceName.length > DEVICE_NAME_MAX_LENGTH) {
    throw new UsageError(t('remote.badDeviceName', { max: DEVICE_NAME_MAX_LENGTH }));
  }
  const trimmed = input.trim();
  const browse = ctx.io.browseMdns ?? browseWevirHosts;
  let targets: PairingTarget[];
  let secret: { kind: 'uri'; secret: string } | { kind: 'code'; code: string };
  if (trimmed.startsWith(PAIRING_URI_PREFIX)) {
    const payload = parsePairingUri(trimmed);
    if (payload === null) {
      throw new CliError(t('remote.badLink'), t('remote.badLink.hint'));
    }
    targets = [linkTarget(payload)];
    secret = { kind: 'uri', secret: payload.secret };
  } else {
    const code = normalizePairingCode(trimmed);
    if (code === null) throw new UsageError(t('remote.badInput'), t('remote.badInput.hint'));
    ctx.print(ctx.styles.dim(t('remote.searching')));
    // 第一台电脑回答之后再等一小会儿收齐同一网络里的其他电脑，不必等满。
    const done = new AbortController();
    let grace: ReturnType<typeof setTimeout> | undefined;
    const found = await browse({
      timeoutMs: DISCOVERY_MS * 2,
      signal: done.signal,
      onFound: () => {
        grace ??= setTimeout(() => done.abort(), DISCOVERY_GRACE_MS);
      },
    });
    clearTimeout(grace);
    targets = found.map(discoveredTarget);
    if (targets.length === 0) {
      throw new CliError(t('remote.noneFound'), t('remote.noneFound.hint'));
    }
    secret = { kind: 'code', code };
  }

  const device = generateKeyPair();
  const identity = await ctx.identity();
  let result: RemotePairingResult | undefined;
  let target: PairingTarget | undefined;
  let lastError: unknown;
  // 短码时局域网里可能有几台电脑：没开配对窗口的拒绝 WebSocket 升级（连不上），不耗短码，依次试下一台。
  for (const candidate of targets) {
    try {
      result = await pairRemoteHost({
        host: { hostPublicKey: candidate.hostPublicKey, routeId: candidate.routeId },
        device,
        secret,
        routes: pairingRoutes(candidate),
        ...(secret.kind === 'uri' && {
          discover: async (add, signal) => {
            await browse({
              timeoutMs: DISCOVERY_MS,
              signal,
              onFound: (host) => {
                if (host.routeId !== candidate.routeId) return;
                for (const route of discoveredTarget(host).routes) add(route);
              },
            });
          },
        }),
        name: deviceName,
        platform: devicePlatform(),
        identity,
        onAwaitingApproval: ({ host }) => {
          ctx.print(
            t('remote.awaitingApproval', {
              host: host.hostName ?? candidate.hostName ?? t('remote.thatComputer'),
              device: deviceName,
            }),
          );
        },
      });
      target = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof RemoteUnreachableError) && !unreachableCause(error)) break;
    }
  }
  if (result === undefined || target === undefined) throw lastError;

  const existing = await listRemoteHosts(ctx.home);
  const previous = existing.find((r) => r.routeId === target.routeId);
  const hostName = result.host.hostName ?? target.hostName;
  const taken = new Set(existing.filter((r) => r !== previous).map((r) => r.name));
  if (options.name !== undefined && taken.has(options.name)) {
    throw new CliError(
      t('remote.nameTaken', { name: options.name }),
      t('remote.nameTaken.hint', { name: options.name }),
    );
  }
  const name = options.name ?? previous?.name ?? uniqueName(slugifyHostName(hostName), taken);
  const winner = (result.route as Partial<CandidateRoute>).candidate;
  const relayUrl = result.host.relayUrl ?? target.relayUrl;
  const record: RemoteHostRecord = {
    version: 1,
    name,
    ...(hostName !== undefined && { hostName }),
    hostPublicKey: target.hostPublicKey,
    routeId: target.routeId,
    deviceSecretKey: encodeSecretKey(device),
    candidates:
      result.host.candidates.length > 0
        ? result.host.candidates
        : target.routes.map((r) => r.candidate),
    ...(winner !== undefined && { lastAddress: { host: winner.host, port: winner.port } }),
    ...(relayUrl !== undefined && { relayUrl }),
    lastRoute: result.route.kind,
    pairedAt: new Date().toISOString(),
    lastConnectedAt: new Date().toISOString(),
  };
  await saveRemoteHost(ctx.home, record);
  if (previous !== undefined && previous.name !== name)
    await removeRemoteHost(ctx.home, previous.name);
  ctx.print(t('remote.paired', { host: hostName ?? name, name }));
  ctx.print(
    ctx.styles.dim(
      t('remote.permissions', {
        permissions: joinList(result.hello.permissions),
      }),
    ),
  );
  ctx.print(ctx.styles.dim(t('remote.pairedNext', { name })));
  return EXIT.ok;
}

function unreachableCause(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { cause?: unknown }).cause instanceof RemoteUnreachableError
  );
}

function linkTarget(payload: PairingPayload): PairingTarget {
  return {
    hostPublicKey: payload.hostPublicKey,
    routeId: payload.routeId,
    ...(payload.hostName !== undefined && { hostName: payload.hostName }),
    routes: payload.candidates.map((c) => candidateRoute(c)),
    ...(payload.relayUrl !== undefined && { relayUrl: payload.relayUrl }),
  };
}

function discoveredTarget(host: DiscoveredHost): PairingTarget {
  return {
    hostPublicKey: host.hostPublicKey,
    routeId: host.routeId,
    routes: host.addresses.map((address) =>
      candidateRoute({ kind: 'lan', host: address, port: host.port }),
    ),
  };
}

function addressLabel(address: StoredCandidate | undefined): string {
  if (address === undefined) return '-';
  return `${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;
}

/** 上次连上走的是直连还是中继；没记下时是 `-`。 */
export function routeLabel(record: RemoteHostRecord): string {
  if (record.lastRoute === 'relay') return t('remote.route.relay');
  if (record.lastRoute === 'direct') return t('remote.route.direct');
  return '-';
}

/** `wevir remote list [--json]`：配对过的电脑。`--json` 不含私钥。 */
export async function remoteList(ctx: Context, options: { json?: boolean }): Promise<number> {
  const records = await listRemoteHosts(ctx.home);
  if (options.json) {
    ctx.print(
      JSON.stringify(
        records.map(({ deviceSecretKey: _secret, ...rest }) => rest),
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  if (records.length === 0) {
    ctx.print(t('remote.none'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      [
        t('remote.col.name'),
        t('remote.col.host'),
        t('remote.col.address'),
        t('remote.col.route'),
        t('remote.col.connected'),
        t('remote.col.paired'),
      ],
      records.map((r) => [
        r.name,
        r.hostName ?? '-',
        addressLabel(r.lastAddress ?? r.candidates[0]),
        routeLabel(r),
        r.lastConnectedAt === undefined ? '-' : formatTime(r.lastConnectedAt),
        formatTime(r.pairedAt),
      ]),
    ),
  );
  return EXIT.ok;
}

/** `wevir remote forget <名称>`：删掉本机记着的这台电脑与给它的密钥。电脑上的设备记录要在那边移除。 */
export async function remoteForget(ctx: Context, name: string): Promise<number> {
  const records = await listRemoteHosts(ctx.home);
  const record = records.find((r) => r.name === name);
  if (record === undefined) {
    throw new CliError(t('remote.unknown', { name }), t('remote.unknown.hint'));
  }
  await removeRemoteHost(ctx.home, name);
  ctx.print(t('remote.forgotten', { name }));
  ctx.print(ctx.styles.dim(t('remote.forgotten.note')));
  return EXIT.ok;
}
