// 配对一台电脑（ADR-0017 §3）：配对链接（二维码、粘贴、系统打开的 `wevir://pair?…`）自带 Host 公钥、路由 ID、候选地址与（开了中继时的）
// 中继地址；短码要先在局域网里用 mDNS 找到广播 `pk` 的电脑。握手之后等电脑上点“允许”，允许了得到一份新记录和这台设备给那台电脑的
// 新私钥。流程照 CLI 的 `wevir remote pair`；网络与 mDNS 由 `PairingEnvironment` 注入，这里只有编排，Vitest 用假的测。

import {
  ConnectionLostError,
  ConnectTimeoutError,
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
} from '@wevir/client-sdk';
import type { KeyPair } from '@wevir/noise';
import {
  CloseCode,
  normalizePairingCode,
  PAIRING_URI_PREFIX,
  type PairingPayload,
  parsePairingUri,
  type RemoteHostPayload,
} from '@wevir/protocol';
import {
  type ComputerRecord,
  type RouteKind,
  type StoredCandidate,
  slugifyHostName,
  uniqueName,
  usableAddress,
} from './records';

export type PairingInput =
  | { kind: 'link'; payload: PairingPayload }
  | { kind: 'code'; code: string }
  | { kind: 'invalid'; reason: 'link' | 'input' };

/** 粘贴或扫到的文字：配对链接或 8 位短码。 */
export function parsePairingInput(text: string): PairingInput {
  const trimmed = text.trim();
  if (trimmed.startsWith(PAIRING_URI_PREFIX)) {
    const payload = parsePairingUri(trimmed);
    return payload === null ? { kind: 'invalid', reason: 'link' } : { kind: 'link', payload };
  }
  const code = normalizePairingCode(trimmed);
  return code === null ? { kind: 'invalid', reason: 'input' } : { kind: 'code', code };
}

/** 局域网里发现的一个 Host（mDNS 的 `_wevir._tcp`，TXT 里的 `rid` 与 `pk`）。 */
export interface DiscoveredHost {
  readonly routeId: string;
  readonly hostPublicKey: string;
  readonly port: number;
  readonly addresses: readonly string[];
}

export interface BrowseOptions {
  timeoutMs: number;
  signal: AbortSignal;
  onFound?: (host: DiscoveredHost) => void;
}

/** 要配对的一台电脑。 */
export interface PairingTarget {
  hostPublicKey: string;
  routeId: string;
  hostName?: string;
  candidates: StoredCandidate[];
  relayUrl?: string;
}

export type PairingSecret = { kind: 'uri'; secret: string } | { kind: 'code'; code: string };

export interface PairAttempt {
  target: PairingTarget;
  secret: PairingSecret;
  device: KeyPair;
  /** 配对链接时：同时在局域网里找同一路由 ID 的地址（链接里的地址可能已经变了）。 */
  rediscover: boolean;
  onAwaitingApproval(host: RemoteHostPayload): void;
  signal: AbortSignal;
}

export interface PairOutcome {
  route: RouteKind;
  /** 直连胜出的地址。 */
  address?: { host: string; port: number };
  host: RemoteHostPayload;
}

export interface PairingEnvironment {
  browse(options: BrowseOptions): Promise<DiscoveredHost[]>;
  /** 在 `target` 的路上做 `XXpsk2` 并等电脑上允许（`pairRemoteHost`）。 */
  pair(attempt: PairAttempt): Promise<PairOutcome>;
  generateKeyPair(): KeyPair;
  now(): Date;
}

export type PairingStage =
  | { kind: 'searching' }
  | { kind: 'connecting' }
  | { kind: 'awaiting_approval'; hostName: string | undefined };

export interface PairingRequest {
  input: Exclude<PairingInput, { kind: 'invalid' }>;
  existing: readonly ComputerRecord[];
  onStage(stage: PairingStage): void;
  signal: AbortSignal;
}

export interface PairingResult {
  record: ComputerRecord;
  /** 这台设备给那台电脑的 Noise 私钥：存进钥匙串，不进记录。 */
  device: KeyPair;
  /** 同一台电脑以前的记录（重新配对）：它的名称换了时调用方删掉旧的。 */
  previous: ComputerRecord | undefined;
}

/** 配对失败里不属于 client-sdk 错误的一种：短码时局域网里没找到电脑。 */
export class NoComputerFoundError extends Error {
  override readonly name = 'NoComputerFoundError';
  constructor() {
    super('no Wevir computer with remote access was found on this network');
  }
}

/** mDNS 等多久（同 CLI：直连先手的两倍）。 */
export const PAIRING_DISCOVERY_MS = 3_000;
/** 第一台电脑回答之后再等多久收齐同一网络里的其他电脑。 */
export const PAIRING_DISCOVERY_GRACE_MS = 300;

export function linkTarget(payload: PairingPayload): PairingTarget {
  return {
    hostPublicKey: payload.hostPublicKey,
    routeId: payload.routeId,
    ...(payload.hostName !== undefined && { hostName: payload.hostName }),
    candidates: payload.candidates.map((c) => ({ ...c })),
    ...(payload.relayUrl !== undefined && { relayUrl: payload.relayUrl }),
  };
}

export function discoveredTarget(host: DiscoveredHost): PairingTarget {
  return {
    hostPublicKey: host.hostPublicKey,
    routeId: host.routeId,
    candidates: discoveredCandidates(host),
  };
}

export function discoveredCandidates(host: DiscoveredHost): StoredCandidate[] {
  const out: StoredCandidate[] = [];
  for (const address of host.addresses) {
    const usable = usableAddress(address);
    if (usable !== undefined && !out.some((c) => c.host === usable))
      out.push({ kind: 'lan', host: usable, port: host.port });
  }
  return out;
}

export async function pairComputer(
  env: PairingEnvironment,
  request: PairingRequest,
): Promise<PairingResult> {
  const { input, signal } = request;
  let targets: PairingTarget[];
  let secret: PairingSecret;
  if (input.kind === 'link') {
    targets = [linkTarget(input.payload)];
    secret = { kind: 'uri', secret: input.payload.secret };
  } else {
    request.onStage({ kind: 'searching' });
    const done = new AbortController();
    const abort = () => done.abort();
    signal.addEventListener('abort', abort);
    let grace: ReturnType<typeof setTimeout> | undefined;
    let found: DiscoveredHost[];
    try {
      found = await env.browse({
        timeoutMs: PAIRING_DISCOVERY_MS,
        signal: done.signal,
        onFound: () => {
          grace ??= setTimeout(() => done.abort(), PAIRING_DISCOVERY_GRACE_MS);
        },
      });
    } finally {
      clearTimeout(grace);
      signal.removeEventListener('abort', abort);
    }
    signal.throwIfAborted();
    targets = found.map(discoveredTarget).filter((t) => t.candidates.length > 0);
    if (targets.length === 0) throw new NoComputerFoundError();
    secret = { kind: 'code', code: input.code };
  }

  const device = env.generateKeyPair();
  let outcome: PairOutcome | undefined;
  let target: PairingTarget | undefined;
  let lastError: unknown;
  // 短码时局域网里可能有几台电脑：没开配对窗口的拒绝 WebSocket 升级（连不上），不耗短码，依次试下一台。
  for (const candidate of targets) {
    signal.throwIfAborted();
    request.onStage({ kind: 'connecting' });
    try {
      outcome = await env.pair({
        target: candidate,
        secret,
        device,
        rediscover: input.kind === 'link',
        onAwaitingApproval: (host) =>
          request.onStage({
            kind: 'awaiting_approval',
            hostName: host.hostName ?? candidate.hostName,
          }),
        signal,
      });
      target = candidate;
      break;
    } catch (error) {
      lastError = error;
      if (!isUnreachable(error)) break;
    }
  }
  if (outcome === undefined || target === undefined) throw lastError;

  const previous = request.existing.find((r) => r.routeId === target.routeId);
  const hostName = outcome.host.hostName ?? target.hostName;
  const taken = new Set(request.existing.filter((r) => r !== previous).map((r) => r.name));
  const name = previous?.name ?? uniqueName(slugifyHostName(hostName), taken);
  const relayUrl = outcome.host.relayUrl ?? target.relayUrl;
  const now = env.now().toISOString();
  const record: ComputerRecord = {
    version: 1,
    name,
    ...(hostName !== undefined && { hostName }),
    hostPublicKey: target.hostPublicKey,
    routeId: target.routeId,
    candidates: outcome.host.candidates.length > 0 ? outcome.host.candidates : target.candidates,
    ...(outcome.address !== undefined && { lastAddress: outcome.address }),
    ...(relayUrl !== undefined && { relayUrl }),
    lastRoute: outcome.route,
    pairedAt: now,
    lastConnectedAt: now,
  };
  return { record, device, previous };
}

function isUnreachable(error: unknown): boolean {
  return (
    error instanceof RemoteUnreachableError ||
    (error instanceof Error && error.cause instanceof RemoteUnreachableError)
  );
}

/** 配对失败对界面的意义（文案键在 i18n 的 `pair.error.*`）。 */
export type PairingFailure =
  | { kind: 'none_found' }
  | { kind: 'denied' }
  | { kind: 'wrong_secret' }
  | { kind: 'host_mismatch' }
  | { kind: 'window_closed' }
  | { kind: 'unreachable' }
  | { kind: 'relay'; relay: RemoteRelayFailure }
  | { kind: 'timeout' }
  | { kind: 'failed' };

export function classifyPairingFailure(error: unknown): PairingFailure {
  if (error instanceof NoComputerFoundError) return { kind: 'none_found' };
  if (error instanceof ConnectTimeoutError) return { kind: 'timeout' };
  if (error instanceof ConnectionLostError) {
    if (error.closeCode === CloseCode.PAIRING_DENIED) return { kind: 'denied' };
    if (error.cause !== undefined) return classifyPairingFailure(error.cause);
    return { kind: 'failed' };
  }
  if (error instanceof RemoteHandshakeError) {
    switch (error.reason) {
      case 'wrong_secret':
        return { kind: 'wrong_secret' };
      case 'host_mismatch':
        return { kind: 'host_mismatch' };
      // 第一条消息后对方直接断开：那台电脑没开着配对窗口（已过期、已用过）。
      case 'rejected':
        return { kind: 'window_closed' };
      case 'timeout':
        return { kind: 'unreachable' };
    }
  }
  if (error instanceof RemoteUnreachableError) {
    return error.relay !== undefined
      ? { kind: 'relay', relay: error.relay }
      : { kind: 'unreachable' };
  }
  if (error instanceof Error && error.cause !== undefined)
    return classifyPairingFailure(error.cause);
  return { kind: 'failed' };
}
