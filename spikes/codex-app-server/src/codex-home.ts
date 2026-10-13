// 独立的 CODEX_HOME：目录必须事先建好（upstream/codex/codex-rs/utils/home-dir/src/lib.rs）。
// config.toml 只写 Provider 的地址与 Key 的变量名，Key 本身只经子进程环境变量传入。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SPIKE_ROOT = resolve(import.meta.dirname, '..');
export const BINARY = join(SPIKE_ROOT, '.bin', 'codex-app-server');

export interface ProviderSpec {
  id: string;
  name: string;
  baseURL: string;
  /** Key 的环境变量名；值另外放进子进程环境。 */
  envKey: string;
  model: string;
  /** 自定义模型目录（models.json 格式）；不给则走未知模型的默认元数据。 */
  catalog?: Record<string, unknown>;
  extra?: string[];
}

/** 关掉对外连接与 Wevir 不需要的 OpenAI 专属功能（见 docs/research/codex-notes.md §6）。 */
export const HARDENING = [
  'check_for_update_on_startup = false',
  'web_search = "disabled"',
  '[analytics]',
  'enabled = false',
  '[features]',
  'plugins = false',
  // 默认 inherit=all 且不套用内置的 *KEY* / *SECRET* / *TOKEN* 排除（ignore_default_excludes 默认 true，
  // upstream/codex/codex-rs/config/src/shell_environment_policy.rs:136），模型跑的命令能读到 Key 的环境变量。
  '[shell_environment_policy]',
  'ignore_default_excludes = false',
  'exclude = ["WEVIR_*"]',
];

export function writeConfig(home: string, provider: ProviderSpec, extraTop: string[] = []): void {
  const lines = [
    `model = ${JSON.stringify(provider.model)}`,
    `model_provider = ${JSON.stringify(provider.id)}`,
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    ...extraTop,
  ];
  if (provider.catalog !== undefined) {
    const file = join(home, 'wevir-models.json');
    writeFileSync(file, JSON.stringify(provider.catalog, null, 2));
    lines.push(`model_catalog_json = ${JSON.stringify(file)}`);
  }
  // TOML：顶层键必须在任何表之前，所以 HARDENING 里的表放在顶层键之后。
  lines.push(...HARDENING);
  lines.push(
    `[model_providers.${provider.id}]`,
    `name = ${JSON.stringify(provider.name)}`,
    `base_url = ${JSON.stringify(provider.baseURL)}`,
    'wire_api = "responses"',
    `env_key = ${JSON.stringify(provider.envKey)}`,
    ...(provider.extra ?? []),
  );
  writeFileSync(join(home, 'config.toml'), `${lines.join('\n')}\n`);
}

/** spike 的临时目录：CODEX_HOME、工作区、假 HOME 都在里面，结束时整体删除。 */
export interface Sandbox {
  root: string;
  codexHome: string;
  workspace: string;
  home: string;
  dispose(): void;
}

export function makeSandbox(label: string): Sandbox {
  // Codex 的 workspace-write 默认把 $TMPDIR 也列为可写，审批用例的“工作区外”目标要另找地方（见 run-all.ts）。
  const root = mkdtempSync(join(tmpdir(), `wevir-codex-${label}-`));
  const sandbox = {
    root,
    codexHome: join(root, 'codex-home'),
    workspace: join(root, 'workspace'),
    home: join(root, 'home'),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
  for (const dir of [sandbox.codexHome, sandbox.workspace, sandbox.home, join(root, 'tmp')]) {
    mkdirSync(dir, { recursive: true });
  }
  return sandbox;
}

/** 白名单环境：不继承调用方 shell 里的 OPENAI_API_KEY 等。 */
export function childEnv(sandbox: Sandbox, extra: Record<string, string>): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: sandbox.home,
    CODEX_HOME: sandbox.codexHome,
    TMPDIR: join(sandbox.root, 'tmp'),
    LANG: 'en_US.UTF-8',
    RUST_LOG: process.env.WEVIR_SPIKE_RUST_LOG ?? 'warn',
    ...extra,
  };
}
