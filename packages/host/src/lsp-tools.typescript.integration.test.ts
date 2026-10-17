// 代码智能（LSP 工具）对真实的 TypeScript 7 语言服务器（`tsc --lsp --stdio`）：临时项目的 node_modules/typescript 链到仓库根目录
// 装的 TypeScript；定义、引用、悬停、调用层次、诊断，以及引擎改了没打开的文件之后诊断跟着变。仓库装的不是 TypeScript 7、或这个
// 平台没有它的原生包时跳过。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { LspManager } from './lsp/manager.js';
import { TYPESCRIPT } from './lsp/servers.js';
import { LspTools } from './lsp-tools.js';
import { useTempDir } from './test-utils.js';

const SESSION = 'ses_ts' as SessionId;
const repoTypeScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'node_modules',
  'typescript',
);
const version = existsSync(join(repoTypeScript, 'package.json'))
  ? (JSON.parse(readFileSync(join(repoTypeScript, 'package.json'), 'utf8')) as { version: string })
      .version
  : '0';
const available =
  Number.parseInt(version, 10) >= 7 &&
  !('missing' in (await TYPESCRIPT.resolve(dirname(dirname(repoTypeScript)), process.env)));

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!available)('LSP tools on TypeScript 7', () => {
  it('answers definitions, references, hover, callers and diagnostics, and follows engine edits', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'src'));
    mkdirSync(join(cwd, 'node_modules'));
    symlinkSync(realpathSync(repoTypeScript), join(cwd, 'node_modules', 'typescript'), 'dir');
    writeFileSync(join(cwd, 'package-lock.json'), '{}');
    writeFileSync(
      join(cwd, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, target: 'es2022', module: 'nodenext', noEmit: true },
        include: ['src'],
      }),
    );
    writeFileSync(
      join(cwd, 'src', 'util.ts'),
      'export function greet(name: string): string {\n  return name.toUpperCase();\n}\n',
    );
    writeFileSync(
      join(cwd, 'src', 'main.ts'),
      "import { greet } from './util.js';\n\nexport function run() {\n  return greet('a') + greet('b');\n}\n",
    );

    const lsp = new LspManager();
    cleanups.push(() => lsp.close());
    const storage = {
      sessions: { get: () => ({ cwd, workspaceId: 'ws' }) },
      workspaces: { get: () => ({ id: 'ws' }) },
    } as unknown as Storage;
    const tools = new LspTools({ storage, lsp });
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.tools.find((candidate) => candidate.name === name);
      const result = await tool?.call(args, {
        sessionId: SESSION,
        signal: new AbortController().signal,
      });
      const first = result?.content[0];
      return first?.type === 'text' ? first.text : '';
    };

    expect(await call('lsp_definition', { path: 'src/main.ts', line: 4, symbol: 'greet' })).toBe(
      'Definition for greet at src/main.ts:4:10:\nsrc/util.ts:1:17  export function greet(name: string): string {',
    );
    expect(await call('lsp_references', { path: 'src/util.ts', line: 1, symbol: 'greet' })).toBe(
      [
        '4 references to greet at src/util.ts:1:17 in 2 files:',
        "src/main.ts:1:10  import { greet } from './util.js';",
        "src/main.ts:4:10  return greet('a') + greet('b');",
        "src/main.ts:4:23  return greet('a') + greet('b');",
        'src/util.ts:1:17  export function greet(name: string): string {',
      ].join('\n'),
    );
    expect(await call('lsp_hover', { path: 'src/main.ts', line: 4, symbol: 'greet' })).toContain(
      'function greet(name: string): string',
    );
    expect(
      await call('lsp_call_hierarchy', {
        path: 'src/util.ts',
        line: 1,
        symbol: 'greet',
        direction: 'incoming',
      }),
    ).toContain(
      "function run  src/main.ts:3:17\n    call at src/main.ts:4:10  return greet('a') + greet('b');",
    );
    expect(await call('lsp_diagnostics', { paths: ['src/main.ts'] })).toMatch(
      /^src\/main\.ts: no errors or warnings\n0 errors, 0 warnings in 1 file \(tsc --lsp \(TypeScript 7/,
    );

    // 引擎改了没打开过的 util.ts：返回类型变成 number，main.ts 里的调用就错了。
    writeFileSync(
      join(cwd, 'src', 'util.ts'),
      'export function greet(name: string): number {\n  return name.length;\n}\n',
    );
    writeFileSync(
      join(cwd, 'src', 'main.ts'),
      "import { greet } from './util.js';\n\nexport function run(): string {\n  return greet('a');\n}\n",
    );
    tools.observe(SESSION, {
      type: 'tool.started',
      engineSessionId: 'e',
      toolCallId: 'c1',
      toolName: 'apply_patch',
      display: { kind: 'edit', paths: ['src/util.ts', 'src/main.ts'] },
    });
    tools.observe(SESSION, {
      type: 'tool.finished',
      engineSessionId: 'e',
      toolCallId: 'c1',
      status: 'completed',
    });
    const report = await call('lsp_diagnostics', {});
    expect(report).toContain(
      "src/main.ts: 1 error\n  4:3 error ts(2322): Type 'number' is not assignable to type 'string'.",
    );
    expect(report).toContain('src/util.ts: no errors or warnings');
  }, 60_000);
});
