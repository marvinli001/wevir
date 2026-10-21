// SPDX-License-Identifier: MIT
// 应用内登录：Wevir 不碰令牌，登录由 Devin CLI 自己完成，凭据照旧存在它自己的 credentials.toml。Wevir 只起一个一次性的
// `devin acp`，`initialize` 之后调 ACP 的 `authenticate`（`devin-browser`，与 Zed 的“Log in with browser”相同）：CLI 在本机开
// 回调端口、自己打开系统浏览器走 PKCE，用户在浏览器里登录后 `authenticate` 返回。3000.11.92 不经 ACP 报出授权地址，所以登录
// 中的状态没有 `authUrl`。
//
// 没登录时 Devin 照样建会话（模型列表为空），检测靠 `devin auth status`（accounts.ts），不靠 ACP。

import path from 'node:path';
import { AcpProcess } from '@wevir/adapter-acp';
import { DEVIN_ENGINE } from './engine.js';
import { type DevinExecutable, DevinLauncher } from './launch.js';
import { record } from './models.js';

/** ACP 的浏览器登录方式（`initialize` 的 `authMethods`）。 */
export const DEVIN_AUTH_METHOD = 'devin-browser';
/** 一次登录最长等多久（用户在浏览器里登录前）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

export type DevinLoginResult = { ok: true } | { ok: false; cancelled: boolean; message: string };

/** 进行中的一次登录。 */
export interface DevinLoginFlow {
  /** `authenticate` 返回时兑现：成功是登录完成；被 `cancel` 停掉的 `cancelled`；其余带 Devin 的说明。 */
  done: Promise<DevinLoginResult>;
  cancel(): void;
}

export interface StartDevinLoginInput {
  executable: DevinExecutable;
  /** 这个一次性进程的工作目录（建在数据目录的引擎目录下）。 */
  directory: string;
  timeoutMs?: number;
}

function messageOf(error: unknown): string {
  const fields = record(error);
  const data = fields?.data;
  if (typeof data === 'string' && data !== '') return data;
  const detail = record(data)?.details ?? record(data)?.message;
  if (typeof detail === 'string' && detail !== '') return detail;
  if (typeof fields?.message === 'string' && fields.message !== '') return fields.message;
  return String(error);
}

/**
 * 启动登录：等 `devin acp` 起来、认得浏览器登录，发出 `authenticate` 就返回（登录还没完成，`done` 之后才兑现）。进程起不来
 * 或不认这种登录方式时抛错。
 */
export async function startDevinLogin(input: StartDevinLoginInput): Promise<DevinLoginFlow> {
  const acp = new AcpProcess({
    engine: DEVIN_ENGINE,
    launcher: new DevinLauncher(input.directory, async () => input.executable),
    clientInfo: { name: 'wevir-devin-login', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    onExtRequest: async () => ({ outcome: 'cancelled' }),
  });
  try {
    const initialize = await acp.start();
    const methods = initialize.authMethods ?? [];
    if (!methods.some((method) => method.id === DEVIN_AUTH_METHOD)) {
      throw new Error(`Devin CLI does not offer ${DEVIN_AUTH_METHOD} sign-in; update the CLI`);
    }
  } catch (error) {
    await acp.dispose().catch(() => {});
    throw error;
  }

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

  const done: Promise<DevinLoginResult> = (async (): Promise<DevinLoginResult> => {
    try {
      await acp.connection.agent.request('authenticate', { methodId: DEVIN_AUTH_METHOD });
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
  return {
    done,
    cancel: () => {
      cancelled = true;
      stop();
    },
  };
}

/** 这个登录进程的工作目录：`<引擎目录>/login`。 */
export function loginDirectory(workDir: string): string {
  return path.join(workDir, 'login');
}
