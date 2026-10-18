// SPDX-License-Identifier: MIT
// 应用内登录：Wevir 不碰令牌，登录由 CodeBuddy 自己完成，凭据照旧存在它自己的位置；Wevir 只起一个一次性的 `codebuddy --acp`，
// `initialize` 之后调 ACP 的 `authenticate`，拿到它经 `_codebuddy.ai/authUrl` 通知发来的授权地址（交给桌面端的系统浏览器），
// 等 `authenticate` 在用户于浏览器里同意后返回。CLI 自己也会按 `$BROWSER`（缺省 open / xdg-open）开浏览器，所以这个进程的
// `BROWSER` 指向一个什么都不做的小程序，免得开两次。
//
// 注意：`authenticate` 在已登录时会先把用户登出再重登，所以只在检测到未登录时才调，绝不用它探测或重试。

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AcpProcess } from '@wevir/adapter-acp';
import { WORKBUDDY_AUTH_URL, WORKBUDDY_ENGINE } from './engine.js';
import { type WorkBuddyExecutable, WorkBuddyLauncher } from './launch.js';
import { record } from './models.js';

/** 等 CodeBuddy 报出登录地址的时限。 */
export const LOGIN_URL_WAIT_MS = 20_000;
/** 一次登录最长等多久（用户在浏览器里同意前）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** ACP 的登录方式：`internal` 是国内版（微信），`external` 是国际版（Google / GitHub）。 */
export type WorkBuddyAuthMethod = 'internal' | 'external';

/** 应用内可选的登录方式（`AccountState.loginOptions`）：`id` 就是 ACP 的 `methodId`，`label` 是登录用的账号，产品名。 */
export interface WorkBuddyLoginOption {
  id: WorkBuddyAuthMethod;
  label: string;
}

const LOGIN_OPTIONS: Readonly<Record<WorkBuddyAuthMethod, WorkBuddyLoginOption>> = {
  internal: { id: 'internal', label: 'WeChat' },
  external: { id: 'external', label: 'Google / GitHub' },
};

/**
 * 应用内能选哪些登录方式，按用户已有的 `CODEBUDDY_INTERNET_ENVIRONMENT`（官方：国际版不设，国内版 `internal`）：没设时两种都
 * 能选，国内版（微信）在前、是缺省；设成 `internal` 或 `external` 时只有对应的一种——继承的环境变量会让 CLI 走那个站，选相反的
 * 会走错端点；iOA、企业域名、云托管要在终端里选环境，返回 undefined（仍给命令）。
 */
export function workbuddyLoginOptions(env: NodeJS.ProcessEnv): WorkBuddyLoginOption[] | undefined {
  const value = env.CODEBUDDY_INTERNET_ENVIRONMENT?.trim().toLowerCase() ?? '';
  if (value === '') return [LOGIN_OPTIONS.internal, LOGIN_OPTIONS.external];
  if (value === 'internal') return [LOGIN_OPTIONS.internal];
  if (value === 'external') return [LOGIN_OPTIONS.external];
  return undefined;
}

/** 应用内登录用的 `methodId`：用户选的（要在 `workbuddyLoginOptions` 里），没选取缺省；应用内不能登录时 undefined。 */
export function workbuddyAuthMethod(
  env: NodeJS.ProcessEnv,
  option?: string,
): WorkBuddyAuthMethod | undefined {
  const options = workbuddyLoginOptions(env);
  if (options === undefined) return undefined;
  if (option === undefined) return options[0]?.id;
  return options.find((entry) => entry.id === option)?.id;
}

export type WorkBuddyLoginResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次登录。 */
export interface WorkBuddyLoginFlow {
  /** 要在浏览器里打开的授权地址；`authenticate` 不需要浏览器就完成时没有。 */
  authUrl: string | undefined;
  /** `authenticate` 返回时兑现：成功是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 CodeBuddy 的说明。 */
  done: Promise<WorkBuddyLoginResult>;
  cancel(): void;
}

export interface StartWorkBuddyLoginInput {
  executable: WorkBuddyExecutable;
  method: WorkBuddyAuthMethod;
  /** 放“什么都不做”的浏览器小程序的目录（建在数据目录的引擎目录下）。 */
  directory: string;
  urlWaitMs?: number;
  timeoutMs?: number;
}

const NO_BROWSER = process.platform === 'win32' ? 'no-browser.cmd' : 'no-browser.sh';
const NO_BROWSER_BODY = process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n';

function writeNoBrowser(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, NO_BROWSER);
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== NO_BROWSER_BODY) writeFileSync(file, NO_BROWSER_BODY, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function messageOf(error: unknown): string {
  const fields = record(error);
  const data = record(fields?.data);
  const detail = data?.details ?? data?.message;
  if (typeof detail === 'string' && detail !== '') return detail;
  if (typeof fields?.message === 'string' && fields.message !== '') return fields.message;
  return String(error);
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 启动登录，等 CodeBuddy 报出授权地址。拿到地址就返回（登录还没完成，`done` 之后才兑现）；进程在报出地址前出错或超时，
 * 抛错（信息是 CodeBuddy 的说明）。
 */
export async function startWorkBuddyLogin(
  input: StartWorkBuddyLoginInput,
): Promise<WorkBuddyLoginFlow> {
  const browser = writeNoBrowser(input.directory);
  const executable: WorkBuddyExecutable = {
    path: input.executable.path,
    env: { ...input.executable.env, BROWSER: browser },
  };
  let reportUrl: (url: string) => void = () => {};
  const urlArrived = new Promise<string>((resolve) => {
    reportUrl = resolve;
  });
  const acp = new AcpProcess({
    engine: WORKBUDDY_ENGINE,
    launcher: new WorkBuddyLauncher(path.dirname(input.directory), async () => executable),
    clientInfo: { name: 'wevir-workbuddy-login', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    onExtRequest: async () => ({ outcome: 'cancelled' }),
    onExtNotification: (method, params) => {
      if (method !== WORKBUDDY_AUTH_URL) return;
      const url = httpUrl(record(params)?.authUrl);
      if (url !== undefined) reportUrl(url);
    },
  });

  let cancelled = false;
  let timedOut = false;
  const stop = () => {
    void acp.dispose();
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs ?? LOGIN_TIMEOUT_MS);
  timeout.unref?.();

  const done: Promise<WorkBuddyLoginResult> = (async (): Promise<WorkBuddyLoginResult> => {
    try {
      await acp.start();
      await acp.connection.agent.request('authenticate', { methodId: input.method });
      return { ok: true };
    } catch (error) {
      if (cancelled) return { ok: false, cancelled: true, message: 'Sign-in was cancelled.' };
      if (timedOut) return { ok: false, cancelled: false, message: 'Sign-in timed out.' };
      return { ok: false, cancelled: false, message: messageOf(error) };
    } finally {
      clearTimeout(timeout);
      await acp.dispose().catch(() => {});
    }
  })();
  const flow = (authUrl: string | undefined): WorkBuddyLoginFlow => ({
    authUrl,
    done,
    cancel: () => {
      cancelled = true;
      stop();
    },
  });

  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    urlArrived.then((url) => ({ url }) as const),
    done.then((result) => ({ result }) as const),
    new Promise<{ expired: true }>((resolve) => {
      waitTimer = setTimeout(
        () => resolve({ expired: true }),
        input.urlWaitMs ?? LOGIN_URL_WAIT_MS,
      );
    }),
  ]);
  clearTimeout(waitTimer);
  if ('url' in first) return flow(first.url);
  if ('result' in first) {
    // 还没给地址就结束了：成功是不需要浏览器（已有凭据），失败带上它的说明。
    if (first.result.ok) return flow(undefined);
    throw new Error(first.result.message);
  }
  cancelled = true;
  stop();
  await done;
  throw new Error(
    `CodeBuddy did not report a sign-in address within ${(input.urlWaitMs ?? LOGIN_URL_WAIT_MS) / 1000} s`,
  );
}
