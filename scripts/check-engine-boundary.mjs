// 引擎边界的第二道防线：检查各工作区包 package.json 里的依赖声明。
//
// 每个引擎的 npm 包只能由它自己的适配器包声明（ENGINES）：@deepseek-ai/* 只在 packages/adapter-dsh，
// @openai/codex（含 @openai/codex-sdk 等 @openai/codex-* 包）只在 packages/adapter-codex（ADR-0005 草案），
// @anthropic-ai/claude-agent-sdk 与 @anthropic-ai/claude-code 只在 packages/adapter-claude（ADR-0005 补记 14）。
// @cursor/sdk（含平台包 @cursor/sdk-*）只在 packages/adapter-cursor（ADR-0005 补记 14）。
// @opencode-ai/*（`@opencode-ai/sdk` 等）与 @opencode/*（2.x 的包）只在 packages/adapter-opencode（ADR-0005 补记 14）。
// @xai-official/grok（Grok Build 的 CLI）谁都不声明：用户自己装，packages/adapter-grok 只启动它，名义上也只许它声明。
// @github/copilot（GitHub Copilot CLI）同样谁都不声明：用户自己装或设置里下载独立程序，packages/adapter-copilot 只启动它。
// Kiro CLI（kiro-cli）不是 npm 包：用户自己装或设置里按官方清单下载，packages/adapter-kiro 只启动它，没有要拦的依赖。
// Biome 的 noRestrictedImports（见 biome.json）负责拦截静态 import、动态 import() 等写法，
// 但看不见 CommonJS require()、createRequire() 之类的加载方式。pnpm 的 node_modules 是隔离的：
// 一个包只能解析到自己声明的依赖，以及根 package.json 的依赖。所以只要适配器包以外
// （包括仓库根）没有声明引擎包，任何写法在运行时都解析不到。
// 前提是不开启 node-linker=hoisted、shamefully-hoist、enableGlobalVirtualStore、preferSymlinkedExecutables，
// 不用 public-hoist-pattern 提升引擎包，并保持 pnpm-workspace.yaml 的 extendNodePath: false：
// 否则命令 shim 会把 node_modules/.pnpm/node_modules 写进 NODE_PATH，require() 经它解析到没声明的包
// （ADR-0004 补记 3）。这一条在安装时才生效，所以本脚本还检查已生成的 shim：设置被去掉、或者 checkout 在
// 设置之前装过依赖（要 pnpm install --force 才会重写 shim），lint 都会失败，而不是让测试静默放过违规写法。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINES = [
  {
    owner: 'packages/adapter-codex',
    label: '@openai/codex*',
    matches: (name, spec) =>
      /^@openai\/codex(-|$)/.test(name) || /^npm:@openai\/codex(-[^@]*)?(@|$)/.test(spec),
  },
  {
    owner: 'packages/adapter-claude',
    label: '@anthropic-ai/claude-agent-sdk、@anthropic-ai/claude-code',
    matches: (name, spec) =>
      /^@anthropic-ai\/claude-(agent-sdk|code)(-|$)/.test(name) ||
      /^npm:@anthropic-ai\/claude-(agent-sdk|code)(-[^@]*)?(@|$)/.test(spec),
  },
  {
    owner: 'packages/adapter-cursor',
    label: '@cursor/sdk*',
    matches: (name, spec) =>
      /^@cursor\/sdk(-|$)/.test(name) || /^npm:@cursor\/sdk(-[^@]*)?(@|$)/.test(spec),
  },
  {
    owner: 'packages/adapter-opencode',
    label: '@opencode-ai/*、@opencode/*',
    matches: (name, spec) => /^@opencode(-ai)?\//.test(name) || /^npm:@opencode(-ai)?\//.test(spec),
  },
  {
    owner: 'packages/adapter-grok',
    label: '@xai-official/grok',
    matches: (name, spec) =>
      name === '@xai-official/grok' || /^npm:@xai-official\/grok(@|$)/.test(spec),
  },
  {
    // 用户自己装，适配器只启动它，没有 npm 依赖。
    owner: 'packages/adapter-workbuddy',
    label: '@tencent-ai/codebuddy-code、@tencent-ai/agent-sdk',
    matches: (name, spec) =>
      /^@tencent-ai\/(codebuddy-code|agent-sdk)(-|$)/.test(name) ||
      /^npm:@tencent-ai\/(codebuddy-code|agent-sdk)(-[^@]*)?(@|$)/.test(spec),
  },
  {
    // 用户自己装或下载官方发布的独立程序，适配器只启动 `copilot --acp`，没有 npm 依赖。
    owner: 'packages/adapter-copilot',
    label: '@github/copilot',
    matches: (name, spec) =>
      /^@github\/copilot(-|$)/.test(name) || /^npm:@github\/copilot(-[^@]*)?(@|$)/.test(spec),
  },
];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const root = fileURLToPath(new URL('..', import.meta.url));

/** 仓库内的相对路径，统一用 / 分隔（Windows 上 relative() 用反斜杠），报错与 CI 注解都用它。 */
const repoPath = (abs) => relative(root, abs).split(sep).join('/');

/** 从 pnpm-workspace.yaml 读取 `<dir>/*` 形式的包目录；遇到其他写法直接报错，避免静默漏检。 */
function workspaceDirs() {
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const section = yaml.match(/^packages:\s*\n((?:[ \t]+-.*\n?)+)/m);
  if (!section) throw new Error('pnpm-workspace.yaml 中找不到 packages 列表');
  return section[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .map((glob) => {
      const m = glob.match(/^([\w.-]+)\/\*$/);
      if (!m) {
        throw new Error(`check-engine-boundary 只支持 "<dir>/*" 形式的工作区路径，遇到："${glob}"`);
      }
      return m[1];
    });
}

function manifests() {
  const dirs = ['.'];
  for (const parent of workspaceDirs()) {
    const abs = join(root, parent);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(abs, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return dirs;
}

const violations = [];
const dirs = manifests();

for (const dir of dirs) {
  const file = join(root, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const where = repoPath(file);
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      for (const engine of ENGINES) {
        if (engine.matches(name, spec) && dir !== engine.owner) {
          violations.push({
            file: where,
            message: `${field}.${name} — 只有 ${engine.owner} 可以依赖 ${engine.label}`,
          });
        }
      }
    }
  }
}

// 命令 shim 是普通文件（POSIX 上是 sh 脚本，Windows 上是 .cmd / .ps1）；符号链接指向的是工具自己的 JS，不检查。
let shims = 0;
for (const dir of dirs) {
  const bin = join(root, dir, 'node_modules', '.bin');
  if (!existsSync(bin)) continue;
  for (const entry of readdirSync(bin, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    shims += 1;
    if (readFileSync(join(bin, entry.name), 'utf8').includes('NODE_PATH')) {
      violations.push({
        file: repoPath(join(bin, entry.name)),
        message:
          '命令 shim 导出了 NODE_PATH：确认 pnpm-workspace.yaml 有 extendNodePath: false，再运行 pnpm install --force',
      });
    }
  }
}

if (violations.length > 0) {
  console.error('引擎边界检查失败（见 AGENTS.md 仓库规则第 2 条）：');
  for (const v of violations) console.error(`  ✗ ${v.file}: ${v.message}`);
  // GitHub Actions 里另输出错误注解，失败原因直接显示在运行摘要与 PR 的文件上。
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const v of violations) console.log(`::error file=${v.file},title=引擎边界::${v.message}`);
  }
  process.exit(1);
}
console.log(`引擎边界：${dirs.length} 个 package.json、${shims} 个命令 shim 检查通过。`);
