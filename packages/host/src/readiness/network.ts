// 网络诊断（项目环境就绪，0.70.0）：项目用哪些包仓库、配没配认证、设了哪些代理，Agent 的命令能不能联网。只做诊断与建议：引擎的沙箱
// 与 Host 的安装都不能把网络限定在包仓库的域名里（下载会重定向到 CDN 与 Git，安装脚本还会自己联网），所以从不说“已隔离”。
// 报告里不带凭据：URL 去掉用户名与口令，代理只列变量名，认证只说有没有。

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentNetwork, NetworkDiagnosis, RegistryInfo } from '@wevir/protocol';
import { joinRel, type ProjectFiles } from './files.js';
import { referencedVariables } from './node.js';
import { tomlSection, tomlString } from './others.js';

export interface NetworkOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home?: string;
  /** 存在 Wevir 里的凭据名。 */
  credentials: ReadonlySet<string>;
  agent?: AgentNetwork;
  /** 有安装方案。 */
  hasPlans: boolean;
  /** 上次安装的失败归类（`network`、`registry_auth`…）。 */
  lastInstallReason?: string;
}

const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'];

/** URL 去掉用户名、口令与查询串。 */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]*@/, '//').slice(0, 500);
  }
}

function hasUserInfo(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.username !== '' || url.password !== '';
  } catch {
    return false;
  }
}

/** `.npmrc` 的 `键=值`（去掉注释）。 */
export function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';') || line.startsWith('['))
      continue;
    const index = line.indexOf('=');
    if (index < 0) continue;
    map.set(line.slice(0, index).trim(), line.slice(index + 1).trim());
  }
  return map;
}

async function readAbsolute(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').catch(() => undefined);
}

/** 认证配得上吗：引用的变量在 Host 的环境里或 Wevir 里存着才算。 */
function authState(value: string | undefined, options: NetworkOptions): RegistryInfo['auth'] {
  if (value === undefined) return 'none';
  const names = referencedVariables(value);
  if (names.some((name) => options.env[name] === undefined && !options.credentials.has(name)))
    return 'missing';
  return 'configured';
}

export async function diagnoseNetwork(
  files: ProjectFiles,
  ecosystems: ReadonlySet<string>,
  nodeDirs: readonly string[],
  pythonDirs: readonly string[],
  options: NetworkOptions,
): Promise<NetworkDiagnosis> {
  const home = options.home ?? homedir();
  const registries: RegistryInfo[] = [];
  const proxy = new Set<string>();
  for (const name of PROXY_VARIABLES) {
    if (options.env[name] !== undefined || options.env[name.toLowerCase()] !== undefined)
      proxy.add(name);
  }

  if (ecosystems.has('node')) {
    const userNpmrc = (await readAbsolute(join(home, '.npmrc'))) ?? '';
    const sources: Array<[string, Map<string, string>]> = [];
    for (const dir of nodeDirs) {
      const text = await files.text(joinRel(dir, '.npmrc'));
      if (text !== undefined) sources.push([joinRel(dir, '.npmrc'), parseIni(text)]);
    }
    sources.push(['~/.npmrc', parseIni(userNpmrc)]);
    const all = new Map<string, string>();
    for (const [, map] of [...sources].reverse())
      for (const [key, value] of map) all.set(key, value);
    for (const key of ['proxy', 'https-proxy']) if (all.has(key)) proxy.add(`npmrc:${key}`);
    const seen = new Set<string>();
    const add = (url: string, source: string) => {
      const clean = sanitizeUrl(url);
      if (seen.has(clean)) return;
      seen.add(clean);
      const hostPath = clean.replace(/^https?:/, '');
      let auth: RegistryInfo['auth'] = hasUserInfo(url) ? 'configured' : 'none';
      for (const [key, value] of all) {
        if (!key.startsWith('//')) continue;
        const [prefix, field] = [
          key.slice(0, key.lastIndexOf(':')),
          key.slice(key.lastIndexOf(':') + 1),
        ];
        if (!['_authToken', '_auth', '_password', 'username'].includes(field)) continue;
        if (hostPath.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))
          auth = authState(value, options);
      }
      if (
        auth === 'none' &&
        clean === sanitizeUrl(all.get('registry') ?? 'https://registry.npmjs.org/')
      ) {
        const global = all.get('_authToken') ?? all.get('_auth');
        if (global !== undefined) auth = authState(global, options);
      }
      registries.push({ ecosystem: 'node', url: clean, source, auth });
    };
    const envRegistry = options.env.npm_config_registry ?? options.env.NPM_CONFIG_REGISTRY;
    if (envRegistry) add(envRegistry, 'env:npm_config_registry');
    for (const [source, map] of sources) {
      for (const [key, value] of map) {
        if (key === 'registry' || /^@[^:]+:registry$/.test(key)) add(value, source);
      }
    }
    for (const dir of nodeDirs) {
      const yarnrc = await files.text(joinRel(dir, '.yarnrc.yml'));
      const server =
        yarnrc === undefined
          ? undefined
          : /^npmRegistryServer:\s*["']?([^"'\s]+)/m.exec(yarnrc)?.[1];
      if (server) {
        const token = /^npmAuthToken:\s*(.+)$/m.exec(yarnrc ?? '')?.[1];
        registries.push({
          ecosystem: 'node',
          url: sanitizeUrl(server),
          source: joinRel(dir, '.yarnrc.yml'),
          auth: authState(token, options),
        });
        seen.add(sanitizeUrl(server));
      }
    }
    if (
      !seen.has('https://registry.npmjs.org/') &&
      ![...sources].some(([, map]) => map.has('registry')) &&
      !envRegistry
    ) {
      registries.unshift({
        ecosystem: 'node',
        url: 'https://registry.npmjs.org/',
        source: 'default',
        auth: 'none',
      });
    }
  }

  if (ecosystems.has('python')) {
    const found: RegistryInfo[] = [];
    for (const key of ['UV_DEFAULT_INDEX', 'UV_INDEX_URL', 'PIP_INDEX_URL']) {
      const value = options.env[key];
      if (value)
        found.push({
          ecosystem: 'python',
          url: sanitizeUrl(value),
          source: `env:${key}`,
          auth: hasUserInfo(value) ? 'configured' : 'none',
        });
    }
    for (const dir of pythonDirs) {
      const pyproject = (await files.text(joinRel(dir, 'pyproject.toml'))) ?? '';
      for (const block of pyproject
        .split(/^\[\[tool\.(?:uv\.index|poetry\.source)\]\]\s*$/m)
        .slice(1)) {
        const url = tomlString(block.split(/^\[/m)[0] ?? '', 'url');
        if (url)
          found.push({
            ecosystem: 'python',
            url: sanitizeUrl(url),
            source: joinRel(dir, 'pyproject.toml'),
            auth: hasUserInfo(url) ? 'configured' : 'none',
          });
      }
    }
    const pipConfigs =
      options.platform === 'win32'
        ? [join(options.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'pip', 'pip.ini')]
        : [
            join(home, '.config', 'pip', 'pip.conf'),
            join(home, '.pip', 'pip.conf'),
            join(home, 'Library', 'Application Support', 'pip', 'pip.conf'),
          ];
    for (const path of pipConfigs) {
      const index = parseIni((await readAbsolute(path)) ?? '').get('index-url');
      if (index) {
        found.push({
          ecosystem: 'python',
          url: sanitizeUrl(index),
          source: path.startsWith(home) ? `~${path.slice(home.length)}` : path,
          auth: hasUserInfo(index) ? 'configured' : 'none',
        });
      }
    }
    registries.push(
      ...(found.length > 0
        ? found
        : [
            {
              ecosystem: 'python',
              url: 'https://pypi.org/simple',
              source: 'default',
              auth: 'none' as const,
            },
          ]),
    );
  }

  if (ecosystems.has('go')) {
    const goproxy = options.env.GOPROXY;
    const first = (goproxy ?? 'https://proxy.golang.org,direct').split(/[,|]/)[0] as string;
    registries.push({
      ecosystem: 'go',
      url: first === 'direct' || first === 'off' ? first : sanitizeUrl(first),
      source: goproxy ? 'env:GOPROXY' : 'default',
      auth: 'none',
    });
  }

  if (ecosystems.has('rust')) {
    const cargoHome = options.env.CARGO_HOME || join(home, '.cargo');
    const configs = [
      ['.cargo/config.toml', await files.text('.cargo/config.toml')],
      ['~/.cargo/config.toml', await readAbsolute(join(cargoHome, 'config.toml'))],
    ] as const;
    let replaced = false;
    for (const [source, text] of configs) {
      if (!text) continue;
      for (const match of text.matchAll(/^\[(registries|source)\.([A-Za-z0-9_-]+)\]\s*$/gm)) {
        const section = tomlSection(text, `${match[1]}.${match[2]}`) ?? '';
        const url = tomlString(section, 'index') ?? tomlString(section, 'registry');
        if (!url) continue;
        const name = (match[2] as string).toUpperCase().replace(/-/g, '_');
        registries.push({
          ecosystem: 'rust',
          url: sanitizeUrl(url.replace(/^sparse\+/, '')),
          source,
          auth: options.env[`CARGO_REGISTRIES_${name}_TOKEN`] !== undefined ? 'configured' : 'none',
        });
        if (/replace-with/.test(text)) replaced = true;
      }
    }
    if (!replaced)
      registries.unshift({
        ecosystem: 'rust',
        url: 'https://index.crates.io/',
        source: 'default',
        auth: 'none',
      });
  }

  const advice: string[] = [];
  if (options.hasPlans) advice.push('install_by_user');
  if (registries.some((registry) => registry.auth === 'missing'))
    advice.push('registry_auth_missing');
  if (options.hasPlans || options.agent !== undefined) advice.push('domains_not_enforced');
  if (proxy.size > 0) advice.push('proxy_configured');
  if (options.lastInstallReason === 'network') advice.push('last_install_network');
  if (options.lastInstallReason === 'registry_auth') advice.push('last_install_auth');
  return {
    registries: registries.slice(0, 20),
    proxy: [...proxy].slice(0, 10),
    ...(options.agent !== undefined && { agent: options.agent }),
    advice: advice.slice(0, 10),
  };
}

/**
 * Agent 的命令能不能联网：Codex 在 `on_request` 与 `auto_review` 下用 workspace-write 沙箱，不开网络（要联网的命令走审批）；
 * `full_access` 不用沙箱。Windows 的受限令牌沙箱怎么管网络说不准。别的引擎由它自己的权限管。
 */
export function agentNetwork(
  engine: string,
  permissionMode: string | undefined,
  platform: NodeJS.Platform,
): AgentNetwork {
  const base = {
    engine,
    ...(permissionMode !== undefined && { permissionMode }),
    domains: 'not_enforced' as const,
  };
  if (engine === 'codex') {
    if (permissionMode === 'full_access') return { ...base, network: 'unrestricted' };
    return { ...base, network: platform === 'win32' ? 'unknown' : 'sandboxed' };
  }
  if (engine === 'echo') return { ...base, network: 'unknown' };
  return { ...base, network: 'engine_managed' };
}
