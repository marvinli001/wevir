// 路径、模型目标、子进程环境、临时工作区与脱敏。
// 所有运行都使用 spikes/dsh-acp/.dsh-home 作为 DSH_HOME，不读写 ~/.dsh；
// 模型 Key 只经子进程环境变量传入，不写入任何文件。

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(SPIKE_DIR, '../..');
export const DSH_HOME = join(SPIKE_DIR, '.dsh-home');
/** dsh 会从 $DSH_AGENTS_HOME（默认 ~/.agents）读取 skills/ 与 AGENTS.md，这里隔离成空目录。 */
export const AGENTS_HOME = join(DSH_HOME, 'agents-home');
export const DSH_BIN = join(SPIKE_DIR, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
export const FIXTURES_DIR = join(SPIKE_DIR, 'fixtures');
export const GENERATED_DIR = join(DSH_HOME, 'wevir-spike');

export const KEY_ENV = 'WEVIR_SPIKE_API_KEY';

/** 模型调用的去向：真实 OpenAI 兼容服务，或本地脚本化 mock（src/mock-llm.ts）。 */
export interface Target {
  /** placeholder：只用于不发请求的协议检查（例如缺少 Key 时的失败形态） */
  kind: 'real' | 'mock' | 'placeholder';
  providerId: string;
  baseURL: string;
  model: string;
  /** 放进子进程环境 WEVIR_SPIKE_API_KEY 的值 */
  key: string;
}

let current: Target | undefined;

export const PLACEHOLDER_TARGET: Target = {
  kind: 'placeholder',
  providerId: 'wevir-spike',
  baseURL: 'https://gateway.example/v1',
  model: 'your-model-id',
  key: '',
};

export function setTarget(target: Target): void {
  current = target;
}

export function currentTarget(): Target | undefined {
  return current;
}

export function target(): Target {
  if (current === undefined) throw new Error('未设置模型目标（run-all 负责 setTarget）');
  return current;
}

/** 真实目标：默认指向 DeepSeek 开放平台的 OpenAI 兼容端点，可用环境变量换成任意服务。 */
export function realTarget(): Target | undefined {
  const key = process.env[KEY_ENV] ?? '';
  if (key.length === 0) return undefined;
  return {
    kind: 'real',
    providerId: 'wevir-spike',
    baseURL: process.env.WEVIR_SPIKE_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.WEVIR_SPIKE_MODEL ?? 'deepseek-flash',
    key,
  };
}

export function keyMissingMessage(): string {
  return [
    '',
    `✗ npm run spike 需要真实模型调用，但没有设置 ${KEY_ENV}。`,
    '',
    '  Key 只通过环境变量传给 dsh 子进程，不写入任何文件。示例：',
    `    export ${KEY_ENV}=sk-...            # 任一 OpenAI 兼容服务的 Key`,
    '    export WEVIR_SPIKE_BASE_URL=...      # 默认 https://api.deepseek.com',
    '    export WEVIR_SPIKE_MODEL=...         # 默认 deepseek-flash',
    '    npm run spike',
    '',
    '  不需要 Key 的跑法：',
    '    npm run spike:mock      全流程，模型换成本地脚本化 mock（确定、可复现）',
    '    npm run spike:keyless   只跑不调用模型的协议部分',
    '',
  ].join('\n');
}

/**
 * dsh 子进程的完整环境：白名单继承 + 显式注入。
 * 不继承父进程里的其他凭据（ANTHROPIC_*、DEEPSEEK_API_KEY 等）：dsh 解析凭据时
 * 继承的环境变量优先级最高。
 */
export function childEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const passthrough = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of passthrough) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  env.DSH_HOME = DSH_HOME;
  env.DSH_AGENTS_HOME = ensureDir(AGENTS_HOME);
  // dsh-base 的 OTel 只在显式反馈后上报；Wevir 仍应默认关闭，避免任何外发。
  env.DSH_TELEMETRY_DISABLED = '1';
  env.NO_COLOR = '1';
  if (current !== undefined) env[KEY_ENV] = current.key;
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

const workspaces: string[] = [];

/** 新建一个临时工作区（realpath，macOS 上 /var → /private/var），退出时由 cleanupWorkspaces 删除。 */
export function makeWorkspace(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-${label}-`)));
  workspaces.push(dir);
  return dir;
}

/**
 * 工作区之外、且不在系统临时目录下的目录。dsh 的 workspace-write 允许写系统临时区，
 * 所以“工作区外写入需要审批”的场景必须用这里的目录。
 */
export function makeOutsideDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(ensureDir(GENERATED_DIR), `outside-${label}-`)));
  workspaces.push(dir);
  return dir;
}

export function cleanupWorkspaces(): number {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
  return workspaces.splice(0).length;
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 把个人路径、临时目录和密钥替换成占位符。 */
export function sanitize(text: string): string {
  let out = text;
  const key = process.env[KEY_ENV];
  if (key !== undefined && key.length > 0) out = out.split(key).join('<REDACTED_KEY>');
  if (current?.kind === 'mock') out = out.split(current.key).join('<MOCK_KEY>');
  const replacements: Array<[string, string]> = [
    [realpathSync(tmpdir()), '<TMP>'],
    [tmpdir().replace(/\/$/, ''), '<TMP>'],
    [DSH_HOME, '<DSH_HOME>'],
    [SPIKE_DIR, '<SPIKE>'],
    [REPO_DIR, '<REPO>'],
    [homedir(), '<HOME>'],
  ];
  for (const [from, to] of replacements) {
    if (from.length > 1) out = out.split(from).join(to);
  }
  // mock 监听随机端口，替换掉以便 fixture 稳定
  out = out.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>');
  const user = process.env.USER;
  if (user !== undefined && user.length > 2) {
    out = out.replace(new RegExp(`\\b${user}\\b`, 'g'), '<USER>');
  }
  return out;
}
