// 不依赖 opencode 的小函数：可执行文件、版本、规则集、配置、模型、工具展示、消息 ID、服务器输出与台账的解析、提问与错误归类。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commonOpenCodeDirs,
  compareVersions,
  detectAvx2,
  findOpenCode,
  OPENCODE_BIN_ENV,
  OPENCODE_LOGIN_COMMAND,
  openCodeAccountEnv,
  openCodeLoginCommand,
  openCodeNpmPackage,
  openCodePackageNames,
  openCodePath,
  parseOpenCodeVersion,
} from './executable.js';
import { newMessageId } from './message-id.js';
import { accountModels, parseModelId, planLabel } from './models.js';
import { errorCategory, questionId, userQuestions } from './opencode-adapter.js';
import {
  childPermissionRules,
  DECLINE_FEEDBACK,
  permissionReply,
  permissionRules,
  SERVER_PERMISSION_CONFIG,
  serverConfigContent,
} from './permissions.js';
import { unsupportedVersion } from './runtime.js';
import type { PermissionRule } from './sdk.js';
import { isNotFound, OPENCODE_SDK_VERSION } from './sdk.js';
import { parseDarwinPs, parseServerUrl } from './server.js';
import { fakeProviderList } from './test-fixtures/fake-opencode.js';
import { openCodeToolDisplay, patchPaths } from './tool-display.js';
import { openCodeAuthPath } from './usage.js';

/** opencode 的 Permission.evaluate：最后一条命中的生效，都不命中是 ask。 */
function evaluate(rules: readonly PermissionRule[], permission: string, pattern: string): string {
  const glob = (value: string, rule: string) =>
    new RegExp(`^${rule.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(value);
  return (
    [...rules]
      .reverse()
      .find((rule) => glob(permission, rule.permission) && glob(pattern, rule.pattern))?.action ??
    'ask'
  );
}

describe('sdk', () => {
  it('OPENCODE_SDK_VERSION 与 package.json 钉的版本相同', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@opencode-ai/sdk']).toBe(OPENCODE_SDK_VERSION);
  });
});

describe('executable', () => {
  it('找 opencode：指定路径 → 环境变量 → PATH → 常见位置', () => {
    const files = new Set([
      '/custom/opencode',
      '/env/opencode',
      '/usr/bin/opencode',
      '/home/u/.opencode/bin/opencode',
    ]);
    const exists = (file: string) => files.has(file);
    const base = { exists, home: '/home/u', platform: 'darwin' as const };
    expect(findOpenCode({ ...base, customPath: '/custom/opencode', env: {} })).toBe(
      '/custom/opencode',
    );
    expect(findOpenCode({ ...base, customPath: '/nope', env: {} })).toBeUndefined();
    expect(
      findOpenCode({ ...base, env: { [OPENCODE_BIN_ENV]: '/env/opencode', PATH: '/usr/bin' } }),
    ).toBe('/env/opencode');
    expect(findOpenCode({ ...base, env: { PATH: '/usr/bin' } })).toBe('/usr/bin/opencode');
    expect(findOpenCode({ ...base, env: { PATH: '/bin' } })).toBe('/home/u/.opencode/bin/opencode');
    expect(findOpenCode({ ...base, customPath: '~/.opencode/bin/opencode', env: {} })).toBe(
      '/home/u/.opencode/bin/opencode',
    );
  });

  it('Windows：.exe 与 npm 的 .cmd 启动脚本、scoop 的目录', () => {
    expect(
      findOpenCode({
        platform: 'win32',
        home: 'C:\\Users\\u',
        env: { Path: 'C:\\npm' },
        exists: (file) => file === 'C:\\npm\\opencode.cmd',
      }),
    ).toBe('C:\\npm\\opencode.cmd');
    expect(commonOpenCodeDirs('C:\\Users\\u', 'win32', {})).toContain('C:\\Users\\u\\scoop\\shims');
  });

  it('交给 opencode 的 PATH 前面是它所在的目录，后面补上存在的常见目录', () => {
    const path = openCodePath(
      '/home/u/.opencode/bin/opencode',
      { PATH: '/usr/bin:/bin' },
      'darwin',
      '/home/u',
      (dir) => dir === '/opt/homebrew/bin',
    );
    expect(path).toBe('/home/u/.opencode/bin:/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('版本：1.x 打印 1.18.32，2.x 打印 opencode v2.0.18', () => {
    expect(parseOpenCodeVersion('1.18.34\n')).toBe('1.18.34');
    expect(parseOpenCodeVersion('opencode v2.0.18')).toBe('2.0.18');
    expect(parseOpenCodeVersion('nothing')).toBeUndefined();
    expect(compareVersions('1.14.19', '1.14.19')).toBe(0);
    expect(compareVersions('1.9.0', '1.14.19')).toBeLessThan(0);
    expect(compareVersions('1.18.34-beta', '1.18.34')).toBe(0);
    expect(unsupportedVersion('1.18.34')).toBeUndefined();
    expect(unsupportedVersion(undefined)).toMatch(/Unable to determine/);
  });

  it('添加的账号：只换数据目录（登录在里面），配置目录与别的上游 Key 不动，首个账号的 OpenCode 凭据不继承', () => {
    const env = openCodeAccountEnv(
      {
        HOME: '/home/u',
        XDG_CONFIG_HOME: '/home/u/.cfg',
        XDG_DATA_HOME: '/home/u/.data',
        OPENCODE_API_KEY: 'main',
        OPENCODE_AUTH_CONTENT: '{}',
        ANTHROPIC_API_KEY: 'shared',
      },
      '/wevir/accounts/opencode-ab12/opencode',
    );
    expect(env).toEqual({
      HOME: '/home/u',
      XDG_CONFIG_HOME: '/home/u/.cfg',
      XDG_DATA_HOME: '/wevir/accounts/opencode-ab12/opencode',
      ANTHROPIC_API_KEY: 'shared',
    });
    expect(openCodeAuthPath(env)).toBe(
      join('/wevir/accounts/opencode-ab12/opencode', 'opencode', 'auth.json'),
    );
  });
});

describe('executable: Wevir 自己装的 opencode', () => {
  it('找的顺序：指定路径 → 环境变量 → PATH → 常见位置 → Wevir 装的（最后才用）', () => {
    const managed = '/data/engines/opencode/runtime/versions/1.19.3/opencode';
    const exists = (files: string[]) => (file: string) => files.includes(file);
    const find = (files: string[], options: Parameters<typeof findOpenCode>[0] = {}) =>
      findOpenCode({
        env: { PATH: '/usr/bin' },
        home: '/home/me',
        platform: 'linux',
        managedPath: managed,
        exists: exists(files),
        ...options,
      });
    expect(find([managed])).toBe(managed);
    // 用户自己装的在 PATH 里或常见位置里时，不动它。
    expect(find([managed, '/usr/bin/opencode'])).toBe('/usr/bin/opencode');
    expect(find([managed, '/home/me/.opencode/bin/opencode'])).toBe(
      '/home/me/.opencode/bin/opencode',
    );
    expect(find([managed], { env: { PATH: '/usr/bin', [OPENCODE_BIN_ENV]: managed } })).toBe(
      managed,
    );
    // 指定的路径不存在：不再自动找，也不退到 Wevir 装的。
    expect(find([managed], { customPath: '/nope/opencode' })).toBeUndefined();
    // Wevir 装的那份文件没了。
    expect(find([])).toBeUndefined();
  });

  it('平台包：darwin / linux / windows × x64 / arm64，Windows 是 opencode.exe', () => {
    expect(openCodeNpmPackage({ platform: 'darwin', arch: 'arm64' })).toEqual({
      packageName: 'opencode-darwin-arm64',
      entry: 'bin/opencode',
      fileName: 'opencode',
    });
    expect(openCodeNpmPackage({ platform: 'win32', arch: 'arm64' })).toEqual({
      packageName: 'opencode-windows-arm64',
      entry: 'bin/opencode.exe',
      fileName: 'opencode.exe',
    });
    expect(openCodeNpmPackage({ platform: 'win32', arch: 'x64', avx2: true })?.packageName).toBe(
      'opencode-windows-x64',
    );
    expect(openCodeNpmPackage({ platform: 'freebsd', arch: 'x64' })).toBeUndefined();
    expect(openCodeNpmPackage({ platform: 'linux', arch: 'ia32' })).toBeUndefined();
    expect(openCodePackageNames({ platform: 'linux', arch: 'riscv64' })).toEqual([]);
  });

  it('变体的优先顺序同 opencode-ai 的 postinstall：x64 没有 AVX2 用 baseline，musl 用 musl', () => {
    const names = (platform: NodeJS.Platform, arch: string, avx2: boolean, musl = false) =>
      openCodePackageNames({ platform, arch, avx2, musl });
    expect(names('darwin', 'x64', true)).toEqual([
      'opencode-darwin-x64',
      'opencode-darwin-x64-baseline',
    ]);
    expect(names('darwin', 'x64', false)).toEqual([
      'opencode-darwin-x64-baseline',
      'opencode-darwin-x64',
    ]);
    expect(names('darwin', 'arm64', false)).toEqual(['opencode-darwin-arm64']);
    expect(names('linux', 'x64', true)).toEqual([
      'opencode-linux-x64',
      'opencode-linux-x64-baseline',
      'opencode-linux-x64-musl',
      'opencode-linux-x64-baseline-musl',
    ]);
    expect(names('linux', 'x64', false)[0]).toBe('opencode-linux-x64-baseline');
    expect(names('linux', 'x64', true, true)[0]).toBe('opencode-linux-x64-musl');
    expect(names('linux', 'x64', false, true)[0]).toBe('opencode-linux-x64-baseline-musl');
    expect(names('linux', 'arm64', true, true)).toEqual([
      'opencode-linux-arm64-musl',
      'opencode-linux-arm64',
    ]);
    expect(names('linux', 'arm64', false)).toEqual([
      'opencode-linux-arm64',
      'opencode-linux-arm64-musl',
    ]);
  });

  it('AVX2：Linux 读 cpuinfo，macOS 问 sysctl，Windows 问 PowerShell，查不出算没有', async () => {
    const cpu = (flags: string) => async () => `processor : 0\nflags : ${flags}\n`;
    expect(await detectAvx2('linux', 'x64', { readFile: cpu('fpu avx avx2 bmi1') })).toBe(true);
    expect(await detectAvx2('linux', 'x64', { readFile: cpu('fpu avx512f') })).toBe(false);
    expect(
      await detectAvx2('linux', 'x64', {
        readFile: async () => {
          throw new Error('no /proc');
        },
      }),
    ).toBe(false);
    expect(await detectAvx2('linux', 'arm64', { readFile: cpu('avx2') })).toBe(false);
    const sysctl = (ok: boolean, stdout: string) => async () => ({ ok, stdout });
    expect(await detectAvx2('darwin', 'x64', { run: sysctl(true, '1\n') })).toBe(true);
    expect(await detectAvx2('darwin', 'x64', { run: sysctl(true, '0\n') })).toBe(false);
    expect(await detectAvx2('darwin', 'x64', { run: sysctl(false, '') })).toBe(false);
    // Windows：第一个 shell 不在就试下一个。
    const calls: string[] = [];
    expect(
      await detectAvx2('win32', 'x64', {
        run: async (shell) => {
          calls.push(shell);
          return shell === 'pwsh.exe'
            ? { ok: true, stdout: 'True\r\n' }
            : { ok: false, stdout: '' };
        },
      }),
    ).toBe(true);
    expect(calls).toEqual(['powershell.exe', 'pwsh.exe']);
  });

  it('登录命令：Wevir 装的写全路径，用户自己的写 opencode', () => {
    expect(openCodeLoginCommand('/data/opencode', true)).toBe('"/data/opencode" auth login');
    expect(openCodeLoginCommand('/usr/bin/opencode', false)).toBe(OPENCODE_LOGIN_COMMAND);
    expect(openCodeLoginCommand(undefined, true)).toBe(OPENCODE_LOGIN_COMMAND);
  });
});

describe('permissions', () => {
  it('请求批准：读与搜索放行，命令、改文件、联网、目录外问，.env 问，未知工具问', () => {
    const rules = permissionRules('on_request');
    expect(evaluate(rules, 'read', 'src/a.ts')).toBe('allow');
    expect(evaluate(rules, 'read', '.env')).toBe('ask');
    expect(evaluate(rules, 'read', 'config/.env.local')).toBe('ask');
    expect(evaluate(rules, 'read', '.env.example')).toBe('allow');
    for (const permission of [
      'glob',
      'grep',
      'list',
      'lsp',
      'todowrite',
      'task',
      'skill',
      'question',
    ]) {
      expect(evaluate(rules, permission, '*')).toBe('allow');
    }
    for (const permission of [
      'bash',
      'edit',
      'webfetch',
      'websearch',
      'codesearch',
      'external_directory',
      'doom_loop',
    ]) {
      expect(evaluate(rules, permission, 'x')).toBe('ask');
    }
    expect(evaluate(rules, 'github_create_issue', '*')).toBe('ask');
    expect(rules.some((rule) => rule.action === 'deny')).toBe(false);
    expect(permissionRules('auto_review')).toEqual(rules);
    expect(permissionRules(undefined)).toEqual(rules);
  });

  it('完全访问：全部放行；额外目录放行进入', () => {
    expect(evaluate(permissionRules('full_access'), 'bash', 'rm -rf x')).toBe('allow');
    const rules = permissionRules('on_request', ['/repo/other/', ' ']);
    expect(evaluate(rules, 'external_directory', '/repo/other/src/a.ts')).toBe('allow');
    expect(evaluate(rules, 'external_directory', '/etc/passwd')).toBe('ask');
    expect(evaluate(rules, 'edit', '/repo/other/src/a.ts')).toBe('ask');
  });

  it('子会话：父会话的规则加上子 agent 自己的限制', () => {
    const parent = permissionRules('on_request');
    const child = childPermissionRules(parent, [
      { permission: 'external_directory', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: '*', action: 'deny' },
    ]);
    expect(child.slice(0, parent.length)).toEqual(parent);
    expect(child.slice(parent.length)).toEqual([
      { permission: 'task', pattern: '*', action: 'deny' },
    ]);
    expect(evaluate(child, 'task', 'general')).toBe('deny');
    expect(evaluate(child, 'bash', 'ls')).toBe('ask');
  });

  it('服务器配置：并进用户的 OPENCODE_CONFIG_CONTENT，不是 JSON 时原样交出', () => {
    expect(JSON.parse(serverConfigContent(undefined))).toEqual({
      permission: SERVER_PERMISSION_CONFIG,
    });
    expect(
      JSON.parse(
        serverConfigContent('{"model":"a/b","permission":{"bash":"allow","read":"deny"}}'),
      ),
    ).toEqual({
      model: 'a/b',
      permission: {
        bash: 'ask',
        read: 'deny',
        edit: 'ask',
        webfetch: 'ask',
        websearch: 'ask',
        codesearch: 'ask',
      },
    });
    expect(JSON.parse(serverConfigContent('{"permission":"allow"}')).permission).toMatchObject({
      '*': 'allow',
      bash: 'ask',
    });
    expect(serverConfigContent('not json')).toBe('not json');
  });

  it('审批的回复', () => {
    expect(permissionReply('accept')).toEqual({ reply: 'once' });
    expect(permissionReply('acceptForSession')).toEqual({ reply: 'always' });
    expect(permissionReply('decline')).toEqual({ reply: 'reject', message: DECLINE_FEEDBACK });
    expect(permissionReply('cancel')).toEqual({ reply: 'reject' });
    expect(permissionReply('nope')).toBeUndefined();
  });
});

describe('models', () => {
  it('模型 ID 拆成上游与模型（模型 ID 可以带 /）', () => {
    expect(parseModelId('openrouter/anthropic/claude')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude',
    });
    expect(parseModelId('echo')).toBeUndefined();
    expect(parseModelId('/echo')).toBeUndefined();
    expect(parseModelId('mock/')).toBeUndefined();
  });

  it('套餐按 connected 的顺序写名字；没接上游时 undefined', () => {
    const list = fakeProviderList();
    expect(planLabel({ ...list, connected: ['other', 'mock'] })).toBe('Other, Mock');
    expect(planLabel({ ...list, connected: [] })).toBeUndefined();
    expect(accountModels({ ...list, connected: [] })).toEqual({ models: [] });
  });
});

describe('tool display', () => {
  it('opencode 的内置工具', () => {
    expect(openCodeToolDisplay('bash', { command: 'ls -la\nmore', description: 'List' })).toEqual({
      kind: 'shell',
      command: 'ls -la\nmore',
      summary: 'ls -la',
    });
    expect(openCodeToolDisplay('read', { filePath: '/a/b.ts' })).toEqual({
      kind: 'read',
      paths: ['/a/b.ts'],
      summary: '/a/b.ts',
    });
    expect(openCodeToolDisplay('write', { filePath: 'x.md', content: '#' })).toMatchObject({
      kind: 'write',
      paths: ['x.md'],
    });
    expect(
      openCodeToolDisplay('edit', { filePath: 'x.ts', oldString: 'a', newString: 'b' }),
    ).toMatchObject({ kind: 'edit' });
    expect(openCodeToolDisplay('grep', { pattern: 'TODO', path: 'src' })).toEqual({
      kind: 'search',
      query: 'TODO',
      summary: 'TODO',
      paths: ['src'],
    });
    expect(openCodeToolDisplay('webfetch', { url: 'https://example.com' })).toEqual({
      kind: 'fetch',
      url: 'https://example.com',
      summary: 'https://example.com',
    });
    expect(openCodeToolDisplay('websearch', { query: 'opencode' })).toMatchObject({
      kind: 'search',
      query: 'opencode',
    });
    expect(openCodeToolDisplay('list', { path: 'src' })).toMatchObject({
      kind: 'read',
      paths: ['src'],
    });
    expect(openCodeToolDisplay('todowrite', { todos: [] })).toEqual({ kind: 'plan' });
    expect(openCodeToolDisplay('github_create_issue', { title: 'x' })).toEqual({ kind: 'unknown' });
  });

  it('apply_patch 从补丁里取文件', () => {
    const patch =
      '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: src/b.ts\n+x\n*** End Patch';
    expect(patchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(openCodeToolDisplay('apply_patch', { patchText: patch })).toEqual({
      kind: 'edit',
      paths: ['src/a.ts', 'src/b.ts'],
      summary: 'src/a.ts, src/b.ts',
    });
  });
});

describe('message ID', () => {
  it('msg_ + 12 位十六进制时间与计数 + 28 位 base62，同一毫秒内递增', () => {
    const first = newMessageId(1_700_000_000_000);
    const second = newMessageId(1_700_000_000_000);
    expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
    expect(first.slice(4, 16) < second.slice(4, 16)).toBe(true);
    expect(newMessageId(1_700_000_000_001).slice(4, 16) > second.slice(4, 16)).toBe(true);
  });
});

describe('server output', () => {
  it('从 stdout 认出服务器地址', () => {
    expect(
      parseServerUrl('Warning: unsecured\nopencode server listening on http://127.0.0.1:4096\n'),
    ).toBe('http://127.0.0.1:4096');
    expect(parseServerUrl('starting')).toBeUndefined();
  });

  it('macOS 的 ps 输出', () => {
    expect(
      parseDarwinPs(
        '  123   123 S    Thu Oct 15 05:45:30 2026     /x/opencode serve --hostname=127.0.0.1 --port=1\n  9 1 Z    Thu Oct  1 01:02:03 2026 zombie\n',
      ),
    ).toEqual([
      {
        pid: 123,
        pgid: 123,
        zombie: false,
        startTime: 'Thu Oct 15 05:45:30 2026',
        command: '/x/opencode serve --hostname=127.0.0.1 --port=1',
      },
      { pid: 9, pgid: 1, zombie: true, startTime: 'Thu Oct  1 01:02:03 2026', command: 'zombie' },
    ]);
  });
});

describe('adapter helpers', () => {
  it('提问的 ID 与转换（opencode 的 custom 默认允许自己填）', () => {
    expect(questionId(0, 'Pick a Colour!')).toBe('question-0-pick-a-colour-');
    expect(questionId(2, '  ')).toBe('question-2');
    expect(
      userQuestions([
        {
          question: '',
          header: 'H',
          options: [{ label: 'A', description: '' }],
          multiple: true,
          custom: false,
        },
      ]),
    ).toEqual([
      {
        id: 'question-0-h',
        header: 'H',
        question: 'H',
        options: [{ label: 'A' }],
        multiSelect: true,
        allowOther: false,
      },
    ]);
  });

  it('错误归类', () => {
    expect(errorCategory({ name: 'ProviderAuthError', data: {} })).toBe('missing_credentials');
    expect(errorCategory({ name: 'APIError', data: { statusCode: 401 } })).toBe(
      'missing_credentials',
    );
    expect(errorCategory({ name: 'APIError', data: { statusCode: 500 } })).toBe('provider');
    expect(errorCategory({ name: 'ContextOverflowError', data: {} })).toBe('provider');
    expect(errorCategory({ name: 'UnknownError', data: {} })).toBe('unknown');
    expect(errorCategory(undefined)).toBe('unknown');
  });

  it('SDK 的 404 与 NotFoundError', () => {
    expect(isNotFound(new Error('x', { cause: { status: 404 } }))).toBe(true);
    expect(isNotFound(new Error('x', { cause: { body: { name: 'NotFoundError' } } }))).toBe(true);
    expect(
      isNotFound(new Error('x', { cause: { status: 400, body: { name: 'NotFoundError' } } })),
    ).toBe(false);
    expect(isNotFound(new Error('boom'))).toBe(false);
  });
});
