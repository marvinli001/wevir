// 代码智能（LSP 工具）：假语言服务器（test-fixtures/fake-lsp.mjs）上的工具结果与格式、位置参数、会话目录限制、诊断（指定文件与
// 引擎改过的文件）、附在其他工具结果后的改动文件错误、崩溃次数上限、空闲关闭与退出回收；服务器的查找与项目根。

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionId } from '@wevir/protocol';
import { type AgentEvent, APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { AppToolError, type AppToolResult } from './app-mcp.js';
import { LspManager, serverEnv } from './lsp/manager.js';
import { GO, nearestRoot, type ServerSpec, TYPESCRIPT } from './lsp/servers.js';
import { findSymbol, LSP_TOOLS, LspTools } from './lsp-tools.js';
import { useTempDir } from './test-utils.js';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-lsp.mjs');
const SESSION = 'ses_test' as SessionId;

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeSpec(env: Record<string, string> = {}): ServerSpec {
  return {
    id: 'fake',
    language: 'Fake',
    extensions: ['.fake'],
    root: async (_file, stop) => stop,
    resolve: async () => ({
      command: process.execPath,
      args: [FAKE_SERVER],
      label: 'fake-lsp',
      ...(Object.keys(env).length > 0 && { settings: env }),
    }),
  };
}

function setup(
  options: {
    env?: Record<string, string>;
    idleMs?: number;
    spec?: ServerSpec;
    link?: boolean;
  } = {},
) {
  const cwd = tempDir();
  // 会话目录经符号链接时（存储里是链接，工具与服务器用真实路径）。
  const sessionCwd = options.link === true ? `${cwd}-link` : cwd;
  if (options.link === true) {
    symlinkSync(cwd, sessionCwd, 'dir');
    cleanups.push(() => rmSync(sessionCwd));
  }
  const log = join(cwd, '..', `${cwd.split('/').at(-1)}-lsp.log`);
  const lsp = new LspManager({
    servers: [options.spec ?? fakeSpec()],
    env: { ...process.env, FAKE_LSP_LOG: log, ...options.env },
    watch: false,
    ...(options.idleMs !== undefined && { idleMs: options.idleMs }),
  });
  cleanups.push(() => lsp.close());
  const storage = {
    sessions: {
      get: (id: string) => (id === SESSION ? { cwd: sessionCwd, workspaceId: 'ws' } : undefined),
    },
    workspaces: { get: () => ({ id: 'ws' }) },
  } as unknown as Storage;
  const tools = new LspTools({ storage, lsp });
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    const result: AppToolResult = await tool.call(args, {
      sessionId: SESSION,
      signal: new AbortController().signal,
    });
    const first = result.content[0];
    return first?.type === 'text' ? first.text : '';
  };
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), text);
  };
  const notifications = () => {
    try {
      return readFileSync(log, 'utf8');
    } catch {
      return '';
    }
  };
  return { cwd, lsp, tools, call, write, notifications };
}

const edit = (toolCallId: string, paths: string[]): AgentEvent[] => [
  {
    type: 'tool.started',
    engineSessionId: 'e1',
    toolCallId,
    toolName: 'apply_patch',
    display: { kind: 'edit', paths },
  },
  { type: 'tool.finished', engineSessionId: 'e1', toolCallId, status: 'completed' },
];

describe('LSP tools on a fake language server', () => {
  it('lists the seven read-only tools', () => {
    const { tools } = setup();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'lsp_definition',
      'lsp_references',
      'lsp_hover',
      'lsp_document_symbols',
      'lsp_workspace_symbols',
      'lsp_call_hierarchy',
      'lsp_diagnostics',
    ]);
    expect(tools.tools.every((tool) => tool.annotations.readOnlyHint === true)).toBe(true);
    expect(tools.tools.map((tool) => tool.name)).toEqual([...LSP_TOOLS]);
    for (const name of LSP_TOOLS) expect(APP_TOOLS_NO_APPROVAL).toContain(name);
  });

  it('finds definitions and references with relative paths, 1-based positions and the source line', async () => {
    const { call, write } = setup();
    write('src/a.fake', 'def alpha\nuse beta\n');
    write('src/b.fake', 'def beta\n\ncall alpha\n');
    // 服务器只认打开过的文档：先打开两个文件。
    await call('lsp_document_symbols', { path: 'src/a.fake' });
    await call('lsp_document_symbols', { path: 'src/b.fake' });

    const definition = await call('lsp_definition', {
      path: 'src/b.fake',
      line: 3,
      symbol: 'alpha',
    });
    expect(definition).toBe('Definition for alpha at src/b.fake:3:6:\nsrc/a.fake:1:5  def alpha');

    const references = await call('lsp_references', { path: 'src/a.fake', line: 1, column: 6 });
    expect(references).toBe(
      '2 references to alpha at src/a.fake:1:6 in 2 files:\nsrc/a.fake:1:5  def alpha\nsrc/b.fake:3:6  call alpha',
    );
    const withoutDeclaration = await call('lsp_references', {
      path: 'src/a.fake',
      line: 1,
      symbol: 'alpha',
      includeDeclaration: false,
    });
    expect(withoutDeclaration).toContain('1 references to alpha');
  });

  it('answers hover, document and workspace symbols and incoming calls', async () => {
    const { call, write } = setup();
    write('a.fake', 'def gamma\ngamma\n');
    expect(await call('lsp_hover', { path: 'a.fake', line: 2, symbol: 'gamma' })).toBe(
      'gamma at a.fake:2:1:\n**gamma**: a fake symbol',
    );
    expect(await call('lsp_document_symbols', { path: 'a.fake' })).toBe(
      'Symbols in a.fake:\nfunction gamma  1:5',
    );
    expect(await call('lsp_workspace_symbols', { query: 'gam' })).toBe(
      '1 symbol matching "gam":\nfunction gamma  a.fake:1:5',
    );
    expect(
      await call('lsp_call_hierarchy', {
        path: 'a.fake',
        line: 1,
        symbol: 'gamma',
        direction: 'incoming',
      }),
    ).toBe(
      'Callers of function gamma:\nfunction caller  a.fake:2:1\n    call at a.fake:2:1  gamma',
    );
  });

  it('rejects bad positions, files outside the session folder and unsupported languages', async () => {
    const { call, write, cwd } = setup();
    write('a.fake', 'def one\n');
    writeFileSync(join(cwd, '..', 'outside.fake'), 'def x\n');
    symlinkSync(join(cwd, '..', 'outside.fake'), join(cwd, 'link.fake'));
    write('a.txt', 'hello\n');
    await expect(call('lsp_hover', { path: 'a.fake', line: 5, column: 1 })).rejects.toThrow(
      'a.fake has 2 lines; line 5 does not exist.',
    );
    await expect(call('lsp_hover', { path: 'a.fake', line: 1, symbol: 'two' })).rejects.toThrow(
      '"two" is not on line 1 of a.fake: def one',
    );
    await expect(call('lsp_hover', { path: 'a.fake', line: 1 })).rejects.toThrow('Give column');
    await expect(
      call('lsp_hover', { path: '../outside.fake', line: 1, column: 1 }),
    ).rejects.toThrow("is not inside this session's folder");
    await expect(call('lsp_hover', { path: 'link.fake', line: 1, column: 1 })).rejects.toThrow(
      "is not inside this session's folder",
    );
    await expect(call('lsp_hover', { path: 'a.txt', line: 1, column: 1 })).rejects.toThrow(
      'No language server for .txt files. Wevir supports Fake.',
    );
    await expect(call('lsp_workspace_symbols', { query: 'x' })).rejects.toBeInstanceOf(
      AppToolError,
    );
  });

  it('reports diagnostics for given files and waits for the pushed result', async () => {
    const { call, write } = setup();
    write('a.fake', 'def ok\nthis is an ERROR here\n');
    write('b.fake', 'def fine\n');
    expect(await call('lsp_diagnostics', { paths: ['a.fake', 'b.fake'] })).toBe(
      [
        'a.fake: 1 error',
        '  2:12 error fake(42): bad thing on line 2',
        'b.fake: no errors or warnings',
        '1 error, 0 warnings in 2 files (fake-lsp).',
      ].join('\n'),
    );
  });

  it('checks the files the engine changed and attaches their errors to the next LSP result', async () => {
    const { call, write, tools, cwd, notifications } = setup();
    write('a.fake', 'def alpha\n');
    write('b.fake', 'def beta\n');
    expect(await call('lsp_diagnostics', {})).toContain('No files changed in this session');
    await call('lsp_hover', { path: 'a.fake', line: 1, symbol: 'alpha' });

    // 引擎改了 a.fake（打开着）与 b.fake（没打开）：交给在运行的服务器。
    write('a.fake', 'def alpha\nERROR\n');
    write('b.fake', 'def beta\nERROR too\n');
    for (const event of edit('call_1', ['a.fake', join(cwd, 'b.fake')]))
      tools.observe(SESSION, event);
    await expect.poll(notifications).toContain(`change ${join(cwd, 'a.fake')} 2`);
    expect(notifications()).toContain(`save ${join(cwd, 'a.fake')}`);
    expect(notifications()).toContain(`watched ${join(cwd, 'b.fake')}:2`);

    const hover = await call('lsp_hover', { path: 'a.fake', line: 1, symbol: 'alpha' });
    expect(hover).toContain('Errors in files you changed since the last LSP result:');
    expect(hover).toContain('a.fake: 1 error\n  2:1 error fake(42): bad thing on line 2');
    expect(hover).toContain('b.fake: 1 error');
    // 报过一次就不再附。
    expect(await call('lsp_hover', { path: 'a.fake', line: 1, symbol: 'alpha' })).not.toContain(
      'Errors in',
    );

    // 失败的修改不算；没有参数的诊断取走改过的文件。
    for (const event of edit('call_2', ['b.fake']).map((event) =>
      event.type === 'tool.finished' ? { ...event, status: 'failed' as const } : event,
    )) {
      tools.observe(SESSION, event);
    }
    write('b.fake', 'def beta\n');
    for (const event of edit('call_3', ['b.fake'])) tools.observe(SESSION, event);
    expect(await call('lsp_diagnostics', {})).toBe(
      'b.fake: no errors or warnings\n0 errors, 0 warnings in 1 file (fake-lsp).',
    );
  });

  it('maps engine paths in a symlinked session folder to the real files', async () => {
    const { call, write, tools, cwd, notifications } = setup({ link: true });
    write('a.fake', 'def alpha\n');
    await call('lsp_hover', { path: 'a.fake', line: 1, symbol: 'alpha' });
    write('a.fake', 'def alpha\nERROR\n');
    for (const event of edit('call_1', [`${cwd}-link/a.fake`])) tools.observe(SESSION, event);
    await expect.poll(notifications).toContain(`change ${join(cwd, 'a.fake')} 2`);
    expect(await call('lsp_diagnostics', {})).toContain('a.fake: 1 error');
  });

  it('says so when no server is running for an edit, without starting one', async () => {
    const { call, write, tools, notifications } = setup();
    write('a.fake', 'def alpha\n');
    write('b.txt', 'x\n');
    for (const event of edit('call_1', ['a.fake'])) tools.observe(SESSION, event);
    await new Promise((done) => setTimeout(done, 400));
    expect(notifications()).toBe('');
    // 没有参数时为改过的文件启动服务器。
    expect(await call('lsp_diagnostics', {})).toContain('a.fake: no errors or warnings');
  });

  it('stops restarting a server that keeps failing and shows its output', async () => {
    const { call, write } = setup({ env: { FAKE_LSP_CRASH: '1' } });
    write('a.fake', 'def alpha\n');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(call('lsp_hover', { path: 'a.fake', line: 1, column: 5 })).rejects.toThrow(
        /Could not start fake-lsp for .*: fake-lsp exited during startup\.\nIts last output:\nfake-lsp: crashing on purpose/,
      );
    }
    await expect(call('lsp_hover', { path: 'a.fake', line: 1, column: 5 })).rejects.toThrow(
      /failed 3 times in the last 5 minutes; Wevir will try again in about 5 min/,
    );
  });

  it('closes idle servers and shuts the rest down on close', async () => {
    const { call, write, lsp, cwd, notifications } = setup({ idleMs: 1500 });
    write('a.fake', 'def alpha\n');
    await call('lsp_hover', { path: 'a.fake', line: 1, column: 5 });
    expect(lsp.running(cwd)).toHaveLength(1);
    await expect.poll(() => lsp.running(cwd).length, { timeout: 6000 }).toBe(0);
    await expect.poll(notifications).toContain('shutdown');
    // 关掉后下一次请求重新启动。
    await call('lsp_hover', { path: 'a.fake', line: 1, column: 5 });
    expect(lsp.running(cwd)).toHaveLength(1);
    await lsp.close();
    expect(lsp.running(cwd)).toHaveLength(0);
    await expect(call('lsp_hover', { path: 'a.fake', line: 1, column: 5 })).rejects.toThrow(
      'Wevir is shutting down.',
    );
  }, 15_000);

  it('reports a missing server with how to install it', async () => {
    const spec: ServerSpec = {
      ...fakeSpec(),
      resolve: async () => ({ missing: 'fake-lsp not found. Install it: brew install fake-lsp' }),
    };
    const { call, write } = setup({ spec });
    write('a.fake', 'def alpha\n');
    await expect(call('lsp_hover', { path: 'a.fake', line: 1, column: 5 })).rejects.toThrow(
      'fake-lsp not found. Install it: brew install fake-lsp',
    );
    expect(await call('lsp_diagnostics', { paths: ['a.fake'] })).toBe(
      'a.fake: not checked: fake-lsp not found. Install it: brew install fake-lsp\n0 errors, 0 warnings in 1 file.',
    );
  });
});

describe('language servers', () => {
  it('finds the project root up to the session folder', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'pkg', 'src'), { recursive: true });
    writeFileSync(join(cwd, 'go.mod'), 'module x\n');
    writeFileSync(join(cwd, 'pkg', 'go.mod'), 'module y\n');
    expect(await nearestRoot(join(cwd, 'pkg', 'src'), cwd, ['go.mod'])).toBe(join(cwd, 'pkg'));
    expect(await nearestRoot(join(cwd, 'pkg', 'src'), join(cwd, 'pkg', 'src'), ['go.mod'])).toBe(
      undefined,
    );
    expect(await GO.root(join(cwd, 'pkg', 'src', 'a.go'), cwd)).toBe(join(cwd, 'pkg'));
    writeFileSync(join(cwd, 'go.work'), 'go 1.22\n');
    expect(await GO.root(join(cwd, 'pkg', 'src', 'a.go'), cwd)).toBe(cwd);
  });

  it('uses the native language server of TypeScript 7 and explains what is missing otherwise', async () => {
    const cwd = tempDir();
    const env = { PATH: join(cwd, 'empty'), HOME: join(cwd, 'home') };
    expect(await TYPESCRIPT.resolve(cwd, env)).toEqual({
      missing: expect.stringContaining(`No TypeScript found for ${cwd}.`),
    });

    const ts = join(cwd, 'node_modules', 'typescript');
    mkdirSync(join(ts, 'lib'), { recursive: true });
    writeFileSync(join(ts, 'package.json'), '{"name":"typescript","version":"5.9.3"}');
    writeFileSync(join(ts, 'lib', 'tsserver.js'), '');
    expect(await TYPESCRIPT.resolve(cwd, env)).toEqual({
      missing:
        'typescript-language-server not found (the project uses TypeScript 5.9.3). Install it: npm i -g typescript-language-server',
    });

    writeFileSync(join(ts, 'package.json'), '{"name":"typescript","version":"7.0.2"}');
    const native = join(
      cwd,
      'node_modules',
      '@typescript',
      `typescript-${process.platform}-${process.arch}`,
    );
    mkdirSync(join(native, 'lib'), { recursive: true });
    writeFileSync(join(native, 'package.json'), '{}');
    const exe = join(native, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc');
    writeFileSync(exe, '');
    expect(await TYPESCRIPT.resolve(cwd, env)).toEqual({
      command: exe,
      args: ['--lsp', '--stdio'],
      label: 'tsc --lsp (TypeScript 7.0.2)',
    });
  });

  it('says how to install gopls', async () => {
    const cwd = tempDir();
    expect(await GO.resolve(cwd, { PATH: join(cwd, 'empty'), HOME: cwd, GOPATH: cwd })).toEqual({
      missing: 'gopls not found. Install it: go install golang.org/x/tools/gopls@latest',
    });
  });

  it("drops Wevir's own variables from the servers' environment and extends PATH", () => {
    const env = serverEnv({ PATH: '/usr/bin', HOME: '/home/u', WEVIR_GATEWAY_TOKEN: 'secret' });
    expect(env.WEVIR_GATEWAY_TOKEN).toBeUndefined();
    expect(env.PATH?.split(':')[0]).toBe('/usr/bin');
    expect(env.PATH).toContain('/home/u/.cargo/bin');
  });

  it('finds a symbol on a line by whole word first', () => {
    expect(findSymbol('const appTools = new AppTools();', 'AppTools')).toBe(21);
    expect(findSymbol('foo.$bar($bar)', '$bar')).toBe(4);
    expect(findSymbol('xfoo', 'foo')).toBe(1);
    expect(findSymbol('abc', 'zzz')).toBe(-1);
  });
});
