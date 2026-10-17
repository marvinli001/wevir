// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/usageLimits.ts（`grokUsageResponseToLimits`、`readGrokCredential`、
// `readGrokAccount`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `rateLimits`（0.45.0 的按月窗口）；周期是每周时报 `windowMinutes`；
// 读到了却没有百分比的账号（还没用过）不报窗口。
//
// Grok 的用量（grok-event-mapping.md §2）：`grok login` 存在 ~/.grok/auth.json（或 `GROK_HOME`）的 grok.com 登录带一个令牌与
// 邮箱，`GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` 用这个令牌读本周期的额度百分比。只读那个文件、不改；
// 用 `XAI_API_KEY`、或配置了别的登录方式 / 端点（环境变量、config.toml 的 auth / grok_com_config / endpoints 段）时不读——那时
// CLI 用的可能是另一个账号（T3）。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { type AccountRateLimitWindow, isoTime } from '@wevir/runtime-adapter';

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
/** 读用量的时限（T3：10 s）。 */
export const USAGE_TIMEOUT_MS = 10_000;

/** 这些环境变量会换掉 CLI 用的账号或端点（T3）。 */
const ALTERNATE_AUTH_ENV = [
  'GROK_OIDC_ISSUER',
  'GROK_OIDC_CLIENT_ID',
  'GROK_OAUTH2_ISSUER',
  'GROK_OAUTH2_CLIENT_ID',
  'GROK_OAUTH2_PRINCIPAL_TYPE',
  'GROK_OAUTH2_PRINCIPAL_ID',
  'GROK_AUTH_PROVIDER_COMMAND',
  'GROK_LOCAL_AUTH',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'GROK_MODELS_BASE_URL',
  'GROK_CONFIG',
  'GROK_CONFIG_PATH',
];
/** auth.json 里默认的 grok.com 登录的键（T3：不从同一个文件里随便挑别的部署的账号）。 */
const CREDENTIAL_KEYS = [
  'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828',
  'https://accounts.x.ai/sign-in',
];

export interface GrokCredential {
  token?: string;
  email?: string;
}

type ReadText = (file: string) => Promise<string>;

/** 读文本文件，不存在时是空字符串；别的错误照抛。 */
async function readOptional(read: ReadText, file: string): Promise<string> {
  try {
    return await read(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * CLI 默认用的 grok.com 登录（T3 的 `readGrokCredential`）；用 API Key 或配置了别的账号、端点时 undefined。
 */
export async function readGrokCredential(
  env: NodeJS.ProcessEnv,
  read: ReadText = (file) => readFile(file, 'utf8'),
  home: string = homedir(),
): Promise<GrokCredential | undefined> {
  if (env.XAI_API_KEY?.trim()) return undefined;
  if (ALTERNATE_AUTH_ENV.some((name) => env[name]?.trim())) return undefined;
  const grokHome =
    env.GROK_HOME?.trim() ||
    path.join(env.HOME?.trim() || env.USERPROFILE?.trim() || home, '.grok');
  for (const configPath of [
    path.join(grokHome, 'config.toml'),
    path.join(grokHome, 'managed_config.toml'),
    path.join(grokHome, 'requirements.toml'),
    '/etc/grok/managed_config.toml',
    '/etc/grok/requirements.toml',
  ]) {
    const config = await readOptional(read, configPath);
    // 这些段能换掉账号或端点，交给 CLI（T3）。
    if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(config)) {
      return undefined;
    }
  }
  const contents =
    env.GROK_AUTH?.trim() || (await readOptional(read, path.join(grokHome, 'auth.json'))) || '{}';
  const credentials = JSON.parse(contents) as Record<string, unknown> | null;
  const entry = CREDENTIAL_KEYS.map((key) => credentials?.[key]).find(
    (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
  );
  if (entry === undefined || entry.auth_mode === 'api_key') return undefined;
  const token = typeof entry.key === 'string' ? entry.key.trim() : '';
  const email = typeof entry.email === 'string' ? entry.email.trim() : '';
  return { ...(token !== '' && { token }), ...(email !== '' && { email }) };
}

/**
 * 计费接口的 JSON → 用量窗口（T3 的 `grokUsageResponseToLimits`）：一个窗口，周期是每周时 `windowMinutes` 10080，每月时按月，
 * 其他周期长度不明。没有百分比（账号还没用过，xAI 这时不给这个字段）时是空的。
 */
export function grokUsageWindows(response: unknown): AccountRateLimitWindow[] {
  const config = (response as { config?: Record<string, unknown> } | null)?.config;
  const usedPercent = config?.creditUsagePercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return [];
  const period = config?.currentPeriod as { type?: unknown; end?: unknown } | undefined;
  const type =
    typeof period?.type === 'string' ? period.type.replace(/^USAGE_PERIOD_TYPE_/, '') : '';
  const resetsAt = typeof period?.end === 'string' ? isoTime(period.end) : undefined;
  return [
    {
      usedPercent,
      ...(type === 'WEEKLY' && { windowMinutes: 7 * 24 * 60 }),
      ...(type === 'MONTHLY' && { period: 'monthly' as const }),
      ...(resetsAt !== undefined && { resetsAt }),
    },
  ];
}

export interface GrokAccountUsage {
  /** 读的是哪个账号（auth.json 里的邮箱）。 */
  email?: string;
  /** `ok: false`：读失败了（调用方留着上一次的值）；`rateLimits` 省略：没有可报的用量。 */
  usage: { ok: true; rateLimits?: AccountRateLimitWindow[] } | { ok: false };
}

export interface GrokUsageRequest {
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  readFile?: ReadText;
  home?: string;
  timeoutMs?: number;
}

/**
 * 读默认 grok.com 登录的邮箱与用量（T3 的 `readGrokAccount`）：邮箱总是读到用量的那个账号。不用默认登录时 undefined。
 * 不抛错；令牌不进任何消息。
 */
export async function readGrokUsage(
  request: GrokUsageRequest,
): Promise<GrokAccountUsage | undefined> {
  let credential: GrokCredential | undefined;
  try {
    credential = await readGrokCredential(request.env, request.readFile, request.home);
  } catch {
    return { usage: { ok: false } };
  }
  if (credential === undefined) return undefined;
  const email = credential.email !== undefined ? { email: credential.email } : {};
  if (credential.token === undefined) return { ...email, usage: { ok: true } };
  try {
    const response = await (request.fetch ?? fetch)(GROK_BILLING_URL, {
      headers: { Authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(request.timeoutMs ?? USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return { ...email, usage: { ok: false } };
    return { ...email, usage: { ok: true, rateLimits: grokUsageWindows(await response.json()) } };
  } catch {
    return { ...email, usage: { ok: false } };
  }
}
