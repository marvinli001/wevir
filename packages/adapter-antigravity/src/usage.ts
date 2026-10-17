// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/antigravityUsageLimits.ts（`makeAntigravityUsageProbe`、`summaryWindows`、
// `modelWindows`、`quotaWindow`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `rateLimits`（0.45.0 的额度名 `scope`，窗口名由界面按长度说）；不读
// Google 账号 ID（T3 用它跨环境合并账号）；只有个人 Google 账号这一种登录（Wevir 只做这种）。
//
// Antigravity 的用量（antigravity-event-mapping.md §2）：Wevir 私有 profile 里的登录文件（antigravity-acp/acp_token.json，运行体
// 登录时写的）带 OAuth 的 client 与 refresh token。这里只读它、不写：用 refresh token 换一个只在内存里的 access token（快过期
// 时再换），再调 Cloud Code 的 `retrieveUserQuotaSummary`（按额度分组的 5 小时、每周窗口；Gemini 一份，Claude 与 GPT 共用一份），
// 没有时退回 `fetchAvailableModels` 里按模型的额度（老账号，没有窗口长度，不猜）。

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type AccountRateLimitWindow, accountRateLimits, isoTime } from '@wevir/runtime-adapter';

const ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** 每个请求的时限（T3：10 s），整次读取 30 s。 */
export const REQUEST_TIMEOUT_MS = 10_000;
export const PROBE_TIMEOUT_MS = 30_000;
/** access token 剩不到这么久就重新换（T3：60 s）。 */
const TOKEN_MARGIN_MS = 60_000;
const FIVE_HOURS = 5 * 60;
const ONE_WEEK = 7 * 24 * 60;

interface TokenFile {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  project_id?: string;
}

interface Quota {
  remainingFraction?: unknown;
  resetTime?: unknown;
}

function parseTokenFile(text: string): TokenFile {
  const value = JSON.parse(text) as Record<string, unknown> | null;
  const field = (name: string) => {
    const entry = value?.[name];
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`the Antigravity sign-in file has no ${name}`);
    }
    return entry;
  };
  const project = value?.project_id;
  return {
    client_id: field('client_id'),
    client_secret: field('client_secret'),
    refresh_token: field('refresh_token'),
    ...(typeof project === 'string' && project !== '' && { project_id: project }),
  };
}

/** 一份额度 → 窗口（T3 的 `quotaWindow`）：用量是 1 减剩余的比例。没有剩余比例时 undefined。 */
function quotaWindow(
  quota: Quota,
  scope: string,
  windowMinutes?: number,
): AccountRateLimitWindow | undefined {
  const remaining = quota.remainingFraction;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined;
  const resetsAt = typeof quota.resetTime === 'string' ? isoTime(quota.resetTime) : undefined;
  return {
    usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
    scope,
    ...(windowMinutes !== undefined && { windowMinutes }),
    ...(resetsAt !== undefined && { resetsAt }),
  };
}

interface Bucket extends Quota {
  bucketId?: unknown;
  window?: unknown;
  displayName?: unknown;
  disabled?: unknown;
}

/**
 * `retrieveUserQuotaSummary` → 窗口（T3 的 `summaryWindows`）：`gemini-` 开头的桶是 Gemini，`3p-` 开头的是 Claude 与 GPT 共用的
 * 那份，别的用组名或桶 ID。`5h` / `weekly` 给窗口长度，别的窗口把桶名接在额度名后面。停用的桶不报。
 */
export function summaryWindows(summary: unknown): AccountRateLimitWindow[] {
  const value = summary as {
    groups?: { displayName?: unknown; buckets?: Bucket[] }[];
    buckets?: Bucket[];
  } | null;
  const groups = value?.groups?.some((group) => (group.buckets?.length ?? 0) > 0)
    ? value.groups
    : [{ buckets: value?.buckets }];
  const windows = new Map<string, AccountRateLimitWindow>();
  for (const group of groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      if (
        typeof bucket.bucketId !== 'string' ||
        bucket.bucketId === '' ||
        bucket.disabled === true
      ) {
        continue;
      }
      const groupName = typeof group.displayName === 'string' ? group.displayName.trim() : '';
      const family = bucket.bucketId.startsWith('gemini-')
        ? 'Gemini'
        : bucket.bucketId.startsWith('3p-')
          ? 'Claude & GPT'
          : groupName || bucket.bucketId;
      const minutes =
        bucket.window === '5h' ? FIVE_HOURS : bucket.window === 'weekly' ? ONE_WEEK : undefined;
      const bucketName = typeof bucket.displayName === 'string' ? bucket.displayName.trim() : '';
      const scope =
        minutes === undefined && bucketName !== '' ? `${family} · ${bucketName}` : family;
      const window = quotaWindow(bucket, scope, minutes);
      if (window !== undefined) windows.set(bucket.bucketId, window);
    }
  }
  return [...windows.values()];
}

/**
 * `fetchAvailableModels` → 窗口（T3 的 `modelWindows`，老账号）：按模型的家族（Gemini、Claude、GPT）合并，同一家族取用得最多
 * 的那个模型；`quotaInfo` 没有长度，`weeklyQuotaInfo` 是每周。
 */
export function modelWindows(response: unknown): AccountRateLimitWindow[] {
  const models = (response as { models?: Record<string, unknown> } | null)?.models;
  if (typeof models !== 'object' || models === null) return [];
  const windows = new Map<string, AccountRateLimitWindow>();
  for (const [modelId, raw] of Object.entries(models)) {
    const model = raw as { modelProvider?: unknown; quotaInfo?: Quota; weeklyQuotaInfo?: Quota };
    const family =
      model.modelProvider === 'MODEL_PROVIDER_GOOGLE' || modelId.startsWith('gemini-')
        ? 'Gemini'
        : model.modelProvider === 'MODEL_PROVIDER_ANTHROPIC' || modelId.startsWith('claude-')
          ? 'Claude'
          : model.modelProvider === 'MODEL_PROVIDER_OPENAI' || modelId.startsWith('gpt-')
            ? 'GPT'
            : undefined;
    if (family === undefined) continue;
    for (const [suffix, quota, minutes] of [
      ['quota', model.quotaInfo, undefined],
      ['weekly', model.weeklyQuotaInfo, ONE_WEEK],
    ] as const) {
      if (quota === undefined || quota === null) continue;
      const window = quotaWindow(quota, family, minutes);
      if (window === undefined) continue;
      const id = `${family}-${suffix}`;
      const previous = windows.get(id);
      if (previous === undefined || window.usedPercent > previous.usedPercent) {
        windows.set(id, window);
      }
    }
  }
  return [...windows.values()];
}

export type AntigravityUsageRead =
  /** `rateLimits` 省略：没有登录文件，或服务没给能用的额度。 */
  | { ok: true; rateLimits?: ReturnType<typeof accountRateLimits> }
  /** 读失败了（调用方留着上一次的值）。 */
  | { ok: false };

export interface AntigravityUsageOptions {
  /** profile 里登录文件的位置（`antigravityTokenPath`）。 */
  tokenPath: string;
  fetch?: typeof fetch;
  readFile?: (file: string) => Promise<string>;
  now?: () => number;
}

/** 读 Antigravity 的额度；access token 只在内存里，按登录文件的内容缓存。 */
export class AntigravityUsage {
  readonly #options: AntigravityUsageOptions;
  #cached: { fingerprint: string; accessToken: string; expiresAt: number } | undefined;
  /** 每次 `clear` 加一：清掉之前开始的读取换到的令牌不再缓存（T3 的 generation）。 */
  #generation = 0;

  constructor(options: AntigravityUsageOptions) {
    this.#options = options;
  }

  /** 登出、换账号：丢掉缓存的 access token。 */
  clear(): void {
    this.#cached = undefined;
    this.#generation++;
  }

  /** 读一次额度。不抛错；令牌不进任何消息。 */
  async read(): Promise<AntigravityUsageRead> {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    let text: string;
    try {
      text = await (this.#options.readFile ?? ((file) => readFile(file, 'utf8')))(
        this.#options.tokenPath,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#cached = undefined;
        return { ok: true };
      }
      return { ok: false };
    }
    try {
      const token = parseTokenFile(text);
      const accessToken = await this.#accessToken(token, signal);
      const body = JSON.stringify(
        token.project_id !== undefined ? { project: token.project_id } : {},
      );
      const summary = await this.#firstWindows(
        'retrieveUserQuotaSummary',
        accessToken,
        body,
        signal,
        summaryWindows,
      );
      const windows =
        summary.length > 0
          ? summary
          : await this.#firstWindows(
              'fetchAvailableModels',
              accessToken,
              body,
              signal,
              modelWindows,
            );
      // 两个接口都没给能用的额度：T3 当作读失败，留着上一次的。
      if (windows.length === 0) return { ok: false };
      return { ok: true, rateLimits: accountRateLimits(windows) };
    } catch {
      return { ok: false };
    }
  }

  async #accessToken(token: TokenFile, signal: AbortSignal): Promise<string> {
    const fingerprint = createHash('sha256')
      .update(`${token.client_id}\0${token.refresh_token}\0${token.project_id ?? ''}`)
      .digest('hex');
    const now = (this.#options.now ?? Date.now)();
    const cached = this.#cached;
    if (cached?.fingerprint === fingerprint && cached.expiresAt > now + TOKEN_MARGIN_MS) {
      return cached.accessToken;
    }
    this.#cached = undefined;
    const generation = this.#generation;
    const refreshed = (await this.#request(GOOGLE_TOKEN_URL, signal, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      }).toString(),
    })) as { access_token?: unknown; expires_in?: unknown } | null;
    const accessToken = refreshed?.access_token;
    const expiresIn = refreshed?.expires_in;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new Error('Google returned no access token');
    }
    if (typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      throw new Error('Google returned no token lifetime');
    }
    if (generation === this.#generation) {
      this.#cached = { fingerprint, accessToken, expiresAt: now + expiresIn * 1000 };
    }
    return accessToken;
  }

  /** 依次试两个端点，第一个给出窗口的为准；单个端点失败只换下一个（T3）。 */
  async #firstWindows(
    operation: string,
    accessToken: string,
    body: string,
    signal: AbortSignal,
    parse: (response: unknown) => AccountRateLimitWindow[],
  ): Promise<AccountRateLimitWindow[]> {
    for (const endpoint of ENDPOINTS) {
      try {
        const windows = parse(
          await this.#request(`${endpoint}/v1internal:${operation}`, signal, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'User-Agent': `antigravity/hub/1.0.0 (aidev_client; os_type=${process.platform}; arch=${process.arch}; cl=963137146)`,
            },
            body,
          }),
        );
        if (windows.length > 0) return windows;
      } catch {
        // 换下一个端点。
      }
    }
    return [];
  }

  /** POST，不跟随重定向（T3 的 MANUAL_REDIRECT），非 2xx 当失败。 */
  async #request(
    url: string,
    signal: AbortSignal,
    init: { headers: Record<string, string>; body: string },
  ): Promise<unknown> {
    const response = await (this.#options.fetch ?? fetch)(url, {
      method: 'POST',
      redirect: 'manual',
      headers: init.headers,
      body: init.body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
}
