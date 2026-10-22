// 验收：构建产物的浏览器入口（dist/index.js 及它能到达的全部文件）不含 node: 导入，也不含 Node 内置
// 模块（ADR-0002 §7）。用本包的 tsdown 配置构建到临时目录，不依赖事先 pnpm build。

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';
import { describe, expect, it } from 'vitest';
import { useTempDir } from './test-utils.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = useTempDir();

const IMPORT_PATTERN =
  /\b(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** 从 `entry` 出发，沿相对导入走遍能到达的文件，返回每个文件里的导入说明符。 */
function reachableImports(entry: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    const specifiers = [...readFileSync(file, 'utf8').matchAll(IMPORT_PATTERN)].map(
      (match) => (match[1] ?? match[2] ?? match[3]) as string,
    );
    files.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    }
  }
  return files;
}

function isNodeBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('node:') ||
    builtinModules.includes(specifier) ||
    builtinModules.includes(specifier.split('/')[0] as string)
  );
}

describe('构建产物', () => {
  it('浏览器入口能到达的文件里没有 node: 导入与 Node 内置模块，外部依赖只有 @wevir/protocol 与 @wevir/noise', async () => {
    const outDir = join(tempDir(), 'dist');
    await build({ cwd: packageDir, outDir, dts: false, logLevel: 'silent' });

    const browser = reachableImports(join(outDir, 'index.js'));
    expect(browser.size).toBeGreaterThan(1);
    const specifiers = [...browser.values()].flat();
    expect(specifiers.filter(isNodeBuiltin)).toEqual([]);
    expect(new Set(specifiers.filter((s) => !s.startsWith('.')))).toEqual(
      new Set(['@wevir/protocol', '@wevir/noise']),
    );
    // Node 的全局 `process`（协议里的 `process.*` 方法名不算）。
    const nodeGlobals =
      /\brequire\s*\(|\bprocess\.(?:env|argv|platform|exit|cwd|nextTick|stdout|stderr|stdin|versions?|on|pid|hrtime)\b|\bBuffer\b/;
    for (const file of browser.keys()) {
      expect(readFileSync(file, 'utf8')).not.toMatch(nodeGlobals);
    }

    // 对照：node 入口确实用到了 Node 内置模块，说明上面的扫描能发现它们。
    const node = [...reachableImports(join(outDir, 'node.js')).values()].flat();
    expect(node.filter(isNodeBuiltin).sort()).toEqual(['node:fs/promises', 'node:path']);
  }, 30_000);
});
