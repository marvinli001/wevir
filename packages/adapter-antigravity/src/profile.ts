// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/antigravityAuthSupport.ts（环境、BROWSER 钩子、私有 profile、登录网址的
// 解析、stdout / stderr 上的登录提示）与 Drivers/AntigravitySkills.ts（用户全局 skills 的两个目录）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成普通 TS；只保留个人 Google 账号登录（oauth-personal），不做 T3 的 API Key、Gemini Enterprise 与
// Vertex（Wevir 不保存这类密钥，AGENTS.md 规则 5）；BROWSER 钩子用 Host 自己的 Node（process.execPath，Electron 里靠
// ELECTRON_RUN_AS_NODE=1）；profile 只有一个（Wevir 一种订阅一个账号），不按实例 ID 分目录；产出 adapter-acp 的
// AcpSpawnSpec 与 AcpProcess 的 stdout / stderr 钩子。
//
// Antigravity 运行体的启动与隔离（docs/architecture/antigravity-event-mapping.md §3）：
// - GEMINI_HOME 指向 `<数据目录>/engines/antigravity/profile`，凭据（antigravity-acp/acp_token.json）只在这里，
//   `AGY_ACP_FORCE_FILE_STORAGE=1` 不用系统钥匙串。Wevir 不读这个文件的内容，只看它在不在。
// - 环境里的 `GEMINI_API_KEY`、`GOOGLE_*` 等去掉，运行体只用这个 profile 里的登录。
// - 运行体是 PyInstaller 单文件，每次启动往临时目录解包约 1 GB：TMPDIR 指向 Wevir 自己的目录，每个进程一个，退出后删掉。
// - 登录时运行体用 Python 的 webbrowser 打开 Google 的登录页：BROWSER 设成一个小 Node 脚本，它不开浏览器，只把网址
//   带标记写到 stderr，Wevir 认出来交给界面（AccountState.login.authUrl）。1.1.1 也可能把网址直接写在 stdout 上，那一行不是
//   JSON-RPC，在 ACP 解码之前去掉。

import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AcpSpawnSpec } from '@wevir/adapter-acp';

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  'Open the following link to authenticate the ACP server: ';
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = '__WEVIR_ANTIGRAVITY_AUTH_URL__';
/** 个人 Google 账号（ACP `authenticate` 的 methodId）。 */
export const ANTIGRAVITY_AUTH_METHOD = 'oauth-personal';

const MAX_AUTHORIZATION_URL_LENGTH = 16_384;
const MAX_BROWSER_HELPER_LINE_LENGTH =
  Math.max(ANTIGRAVITY_AUTH_BROWSER_MARKER.length, ANTIGRAVITY_AUTH_STDOUT_PREFIX.length) +
  MAX_AUTHORIZATION_URL_LENGTH +
  2;
const MAX_STDOUT_LINE_BYTES = 16 * 1024 * 1024;
const AUTH_PREFIX_BYTES = new TextEncoder().encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
const BROWSER_PREFLIGHT_URL = 'https://example.invalid/wevir-antigravity-browser-preflight';
const BROWSER_PREFLIGHT_TIMEOUT_MS = 5_000;

// Python 先按平台的路径分隔符切开 BROWSER 再解析引号：脚本里不能有冒号和分号。EPIPE 也要以 0 退出，否则取消之后
// Python 会退回去开系统浏览器。
const BROWSER_HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;

const REMOVED_ENVIRONMENT_KEYS = new Set([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'ANTIGRAVITY_HARNESS_PATH',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
]);

export interface AntigravityProfile {
  readonly platform: NodeJS.Platform;
  readonly geminiHome: string;
  readonly acpDirectory: string;
  /** 运行体存登录的文件；Wevir 只看它在不在，不读内容。 */
  readonly tokenPath: string;
  /** 每个进程的临时目录的上级（PyInstaller 往里解包）。 */
  readonly tempDirectory: string;
  readonly browserCommand: string;
}

/** profile 里登录文件的位置（不建目录、不读内容）。 */
export function antigravityTokenPath(profileDirectory: string): string {
  return path.join(path.resolve(profileDirectory), 'antigravity-acp', 'acp_token.json');
}

/** `~` 在运行体里展开成的目录。 */
export function resolveAntigravityUserHome(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    if (env.USERPROFILE) return env.USERPROFILE;
    if (env.HOMEDRIVE && env.HOMEPATH) return `${env.HOMEDRIVE}${env.HOMEPATH}`;
    return home;
  }
  return env.HOME || home;
}

/**
 * 运行体在 GEMINI_HOME 下读的两个用户全局 skills 目录：`config/skills`（与 Antigravity IDE、CLI 共用）与
 * `antigravity-cli/skills`（`agy` CLI 装的）。
 */
export function antigravityUserSkillDirectories(geminiHome: string): readonly [string, string] {
  return [
    path.join(geminiHome, 'config', 'skills'),
    path.join(geminiHome, 'antigravity-cli', 'skills'),
  ];
}

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 交给运行体的环境：去掉会盖过 profile 登录的变量，加上 profile、BROWSER 钩子与自己的临时目录。 */
export function antigravityEnvironment(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv,
  runtimeTempDirectory?: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    // Windows 的环境变量名不分大小写，别名也去掉。
    if (!REMOVED_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  const tempDirectory = runtimeTempDirectory ?? profile.tempDirectory;
  return {
    ...environment,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: '1',
    // BROWSER 钩子用的是 Host 自己的可执行文件：Electron 里要以 Node 运行。
    ELECTRON_RUN_AS_NODE: '1',
    ...(profile.platform === 'win32'
      ? { TEMP: tempDirectory, TMP: tempDirectory }
      : { TMPDIR: tempDirectory }),
  };
}

export interface PrepareProfileOptions {
  /** GEMINI_HOME：`<数据目录>/engines/antigravity/profile`。 */
  profileDirectory: string;
  /** 每个进程的临时目录的上级：`<数据目录>/engines/antigravity/tmp`。 */
  tempDirectory: string;
  baseEnv: NodeJS.ProcessEnv;
  /** BROWSER 钩子用的 Node；默认 Host 自己（process.execPath）。 */
  nodeExecutable?: string;
  platform?: NodeJS.Platform;
  userHome?: string;
  /** 告警出口（skills 链接不上等，不影响启动）。 */
  warn?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * 准备私有 profile：核对 BROWSER 钩子真的只把网址写到 stderr（不会开系统浏览器）、建目录（0700）、写 settings.json
 * （登录方式，不含凭据）、把用户 `~/.gemini` 下的两个 skills 目录链进来。不读、不复制 Google 凭据。
 */
export async function prepareAntigravityProfile(
  options: PrepareProfileOptions,
): Promise<AntigravityProfile> {
  const platform = options.platform ?? process.platform;
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const helperExecutable =
    platform === 'win32' ? nodeExecutable.replaceAll('\\', '/') : nodeExecutable;
  const browserCommand = [helperExecutable, '-e', BROWSER_HELPER_SOURCE, '--', '%s']
    .map(quoteBrowserArgument)
    .join(' ');
  if (
    browserCommand.includes(platform === 'win32' ? ';' : ':') ||
    /[\r\n\0]/u.test(helperExecutable) ||
    helperExecutable.includes('%s')
  ) {
    throw new Error(
      'The Wevir runtime path cannot be used to suppress Antigravity browser launches.',
    );
  }
  const geminiHome = path.resolve(options.profileDirectory);
  const acpDirectory = path.join(geminiHome, 'antigravity-acp');
  const profile: AntigravityProfile = {
    platform,
    geminiHome,
    acpDirectory,
    tokenPath: path.join(acpDirectory, 'acp_token.json'),
    tempDirectory: path.resolve(options.tempDirectory),
    browserCommand,
  };
  // 每次启动都要多起一个进程（Electron 以 Node 运行约 50–100 ms）：同一个可执行文件验过一次就够了。
  if (!verifiedHelpers.has(helperExecutable)) {
    await verifyBrowserHelper(helperExecutable, antigravityEnvironment(profile, options.baseEnv));
    verifiedHelpers.add(helperExecutable);
  }
  for (const directory of [geminiHome, acpDirectory, profile.tempDirectory]) {
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    if (platform !== 'win32') await fsp.chmod(directory, 0o700);
  }
  // 每次启动都重写：运行体登录后也会在这里记下 auth.type，与写下的一致。
  await fsp.writeFile(
    path.join(acpDirectory, 'settings.json'),
    `${JSON.stringify({ auth: { type: ANTIGRAVITY_AUTH_METHOD } })}\n`,
  );
  await linkUserSkills(
    geminiHome,
    options.userHome ?? resolveAntigravityUserHome(platform, options.baseEnv),
    platform,
    options.warn,
  );
  return profile;
}

/** 验过的 BROWSER 钩子（可执行文件路径），整个 Host 进程内有效。 */
const verifiedHelpers = new Set<string>();

/** 钩子必须只往 stderr 写一行带标记的网址并以 0 退出，否则运行体可能去开系统浏览器。 */
async function verifyBrowserHelper(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(executable, ['-e', BROWSER_HELPER_SOURCE, '--', BROWSER_PREFLIGHT_URL], {
    env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = 0;
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.byteLength;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Antigravity browser suppression verification timed out.'));
    }, BROWSER_PREFLIGHT_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (
    exitCode !== 0 ||
    stdout !== 0 ||
    stderr !== `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"${BROWSER_PREFLIGHT_URL}"\n`
  ) {
    throw new Error('Antigravity browser suppression could not be verified.');
  }
}

/**
 * 运行体在 GEMINI_HOME 下读用户全局的 skills，而 GEMINI_HOME 是私有 profile：把这两个目录链回用户真正的 `~/.gemini`，
 * 全局 skills 照常加载，MCP 服务、hooks 与凭据仍然隔离。尽力而为：链不上只少了全局 skills；链接位置已有真目录时那是
 * 用户自己的内容，不动。用户那边没有这个目录（没装 `agy` CLI 时 `antigravity-cli/skills` 通常不存在）就不链，以前链过的
 * 删掉：悬空的链接会被运行体解析成真实路径交给模型，模型拿它当工作目录，命令就起不来。
 */
async function linkUserSkills(
  geminiHome: string,
  userHome: string,
  platform: NodeJS.Platform,
  warn?: PrepareProfileOptions['warn'],
): Promise<void> {
  const links = antigravityUserSkillDirectories(geminiHome);
  const targets = antigravityUserSkillDirectories(path.join(userHome, '.gemini'));
  for (const [index, link] of links.entries()) {
    const target = targets[index] as string;
    try {
      const existing = await fsp
        .readlink(link)
        .then((value) => path.resolve(path.dirname(link), value))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
      const present = await fsp.stat(target).then(
        (stats) => stats.isDirectory(),
        () => false,
      );
      if (!present) {
        if (existing !== undefined) await fsp.rm(link, { force: true });
        continue;
      }
      if (existing === target) continue;
      if (existing !== undefined) await fsp.rm(link, { force: true });
      await fsp.mkdir(path.dirname(link), { recursive: true });
      await fsp.symlink(target, link, platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      warn?.('Antigravity 用户 skills 没有链进 profile', {
        link,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export interface SpawnSpecInput {
  installation: { executablePath: string; harnessPath: string };
  profile: AntigravityProfile;
  /** 进程的 cwd；会话的目录经 ACP `session/new` 的 `cwd` 给出。 */
  cwd: string;
  baseEnv: NodeJS.ProcessEnv;
  /** 这个进程自己的临时目录。 */
  runtimeTempDirectory: string;
}

/** 每个 Antigravity 进程同一套只用订阅登录的启动参数。 */
export function antigravitySpawnSpec(input: SpawnSpecInput): AcpSpawnSpec {
  const { platform } = input.profile;
  return {
    command: input.installation.executablePath,
    args: platform === 'linux' ? ['--uid='] : [],
    options: {
      cwd: input.cwd,
      env: {
        ...antigravityEnvironment(input.profile, input.baseEnv, input.runtimeTempDirectory),
        ANTIGRAVITY_HARNESS_PATH: input.installation.harnessPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // POSIX 上自成进程组，回收时连同它留下的工具子进程一起结束（acp-process.ts 的 signal）。
      detached: platform !== 'win32',
      windowsHide: true,
    },
  };
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

/** 只解析公开的登录请求网址（Google 的 OAuth 页、回调落在本机 127.0.0.1），不碰令牌文件。不合规时返回 undefined。 */
export function parseAntigravityAuthorizationUrl(
  authorizationUrl: string,
): AntigravityAuthorizationUrl | undefined {
  if (authorizationUrl.length > MAX_AUTHORIZATION_URL_LENGTH || /\s/u.test(authorizationUrl)) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    return undefined;
  }
  const state = url.searchParams.get('state');
  const redirectUri = url.searchParams.get('redirect_uri');
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.getAll('redirect_uri').length !== 1 ||
    url.searchParams.getAll('response_type').length !== 1 ||
    url.searchParams.get('response_type') !== 'code' ||
    state === null ||
    state.length === 0 ||
    state.length > 512 ||
    /\s/u.test(state) ||
    redirectUri === null ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/u.test(redirectUri)
  ) {
    return undefined;
  }
  if (Number(new URL(redirectUri).port) < 1024) return undefined;
  return { authorizationUrl, redirectUri, state };
}

/**
 * stdout 的改写（AcpProcess 的 `transformStdout`）：以登录提示开头的行不是 JSON-RPC，去掉，网址交给 `onUrl`
 * （不合规的网址只丢弃）。其余字节原样按行转发。
 */
export function antigravityStdoutFilter(
  onUrl: (url: AntigravityAuthorizationUrl) => void,
): (stdout: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array> {
  return (stdout) => {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const finishLine = (): Uint8Array => {
      const line = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      return line;
    };
    const handleLine = (
      line: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>,
    ) => {
      if (!AUTH_PREFIX_BYTES.every((byte, index) => line[index] === byte)) {
        controller.enqueue(line);
        return;
      }
      const message = new TextDecoder().decode(line).replace(/\r?\n$/u, '');
      const parsed = parseAntigravityAuthorizationUrl(
        message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length),
      );
      if (parsed !== undefined) onUrl(parsed);
    };
    return stdout.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const newline = chunk.indexOf(10, offset);
            const end = newline === -1 ? chunk.byteLength : newline + 1;
            const part = chunk.subarray(offset, end);
            if (pendingBytes + part.byteLength > MAX_STDOUT_LINE_BYTES) {
              controller.error(new Error('Antigravity sent a protocol line that is too large.'));
              return;
            }
            pending.push(part);
            pendingBytes += part.byteLength;
            if (newline !== -1) handleLine(finishLine(), controller);
            offset = end;
          }
        },
        flush(controller) {
          if (pendingBytes > 0) handleLine(finishLine(), controller);
        },
      }),
    );
  };
}

/** stderr 的观察（AcpProcess 的 `onStderr`）：认出 BROWSER 钩子与 1.1.1 原生的登录网址，交给 `onUrl`。不记日志。 */
export function antigravityStderrWatcher(
  onUrl: (url: AntigravityAuthorizationUrl) => void,
): (chunk: string) => void {
  let pending = '';
  const handleLine = (line: string) => {
    const message = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (message.length > MAX_BROWSER_HELPER_LINE_LENGTH) return;
    let url: string | undefined;
    if (message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)) {
      url = message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length);
    } else if (message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER)) {
      try {
        const decoded: unknown = JSON.parse(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length));
        if (typeof decoded === 'string') url = decoded;
      } catch {
        return;
      }
    }
    if (url === undefined) return;
    const parsed = parseAntigravityAuthorizationUrl(url);
    if (parsed !== undefined) onUrl(parsed);
  };
  return (text) => {
    const lines = `${pending}${text}`.split('\n');
    pending = lines.pop() ?? '';
    if (pending.length > MAX_BROWSER_HELPER_LINE_LENGTH) pending = '';
    for (const line of lines) handleLine(line);
  };
}
