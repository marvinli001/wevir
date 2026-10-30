import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyKiroResumeError, classifyKiroTurnError, isKiroAuthRequired } from './engine.js';
import {
  commonKiroDirs,
  findKiro,
  KIRO_ACP_ARGS,
  kiroApiKeyEnv,
  kiroEnv,
  kiroInstallCommand,
  kiroLoginCommand,
  managedKiroEnv,
  parseKiroVersion,
} from './launch.js';
import { parseDeviceCode } from './login.js';
import { kiroModels, withModelOption } from './models.js';
import { readSample } from './test-fixtures/harness.js';
import { kiroToolDisplay } from './tool-display.js';

describe('错误归类', () => {
  it('没登录（2.36.0 的 `kiro-cli acp` 原文）', () => {
    const message =
      'Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.';
    expect(isKiroAuthRequired({ code: -32603, message })).toBe(true);
    expect(classifyKiroTurnError({ code: -32603, message })).toMatchObject({
      category: 'missing_credentials',
      code: -32603,
    });
    expect(isKiroAuthRequired({ code: -32603, message: 'Unexpected failure' })).toBe(false);
  });
  it('额度与限流归 provider，其余 unknown', () => {
    for (const message of [
      'MonthlyRequestCount: you have used all your credits',
      'ThrottlingException: Rate exceeded',
      'Service overloaded, try again',
    ]) {
      expect(classifyKiroTurnError({ code: -32603, message }).category).toBe('provider');
    }
    expect(
      classifyKiroTurnError({ code: -32603, message: 'x', data: { message: 'quota exceeded' } }),
    ).toMatchObject({ category: 'provider', message: 'quota exceeded' });
    expect(classifyKiroTurnError({ code: -32603, message: 'boom' }).category).toBe('unknown');
  });
  it('session/load 找不到会话是 lost，其余 unknown', () => {
    expect(classifyKiroResumeError(readSample('notFound'))).toMatchObject({
      failure: { kind: 'lost', reason: 'not_found' },
    });
    expect(classifyKiroResumeError({ code: -32603, message: 'boom' }).failure).toEqual({
      kind: 'unknown',
    });
  });
});

describe('模型', () => {
  const models = readSample('models');
  it('读 ACP 的 models；没有时读 configOptions 的模型选项；都没有是 undefined', () => {
    expect(kiroModels(undefined, models)).toEqual({
      models: [
        { id: 'auto', displayName: 'Auto' },
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'auto',
    });
    expect(
      kiroModels([
        {
          id: 'model',
          type: 'select',
          currentValue: 'b',
          options: [
            { value: 'a', name: 'A' },
            { value: 'b', name: 'B' },
          ],
        },
      ]),
    ).toEqual({
      models: [
        { id: 'a', displayName: 'A' },
        { id: 'b', displayName: 'B' },
      ],
      defaultModelId: 'b',
    });
    expect(kiroModels(undefined, { availableModels: [] })).toBeUndefined();
    expect(kiroModels(undefined)).toBeUndefined();
  });
  it('withModelOption：把 models 换成 ID 为 model 的选项，已有模型选项或没有模型时原样返回', () => {
    expect(withModelOption(undefined, models)).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'fixture-model-a', name: 'Fixture A' },
          { value: 'fixture-model-b', name: 'Fixture B' },
        ],
      },
    ]);
    const existing = [{ id: 'm', type: 'select', category: 'model', options: [] }];
    expect(withModelOption(existing, models)).toBe(existing);
    const mode = [{ id: 'mode', type: 'select', category: 'mode', options: [] }];
    expect(withModelOption(mode, { availableModels: [] })).toBe(mode);
    expect(withModelOption(mode, models)).toHaveLength(2);
  });
});

describe('设备码登录的输出', () => {
  it('取 2.36.0 打印的网址与码，去掉进度条的控制序列', () => {
    expect(
      parseDeviceCode(
        '\nConfirm the following code in the browser\nCode: ABCD-EFGH\n\nOpen this URL: https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH\n\u001b[?25l\r▀▁ Logging in...',
      ),
    ).toEqual({
      url: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
      code: 'ABCD-EFGH',
    });
    expect(
      parseDeviceCode('Open this URL: https://view.awsapps.com/start/#/device?user_code=WXYZ-0000'),
    ).toEqual({
      url: 'https://view.awsapps.com/start/#/device?user_code=WXYZ-0000',
      code: 'WXYZ-0000',
    });
    expect(parseDeviceCode('Code: ABCD-EFGH')).toBeUndefined();
    expect(parseDeviceCode('Logging in...')).toBeUndefined();
  });
});

describe('工具展示', () => {
  const update = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind, ...extra }) as never;
  it('按 Kiro 的工具名，认不出时按 ACP 的 kind', () => {
    expect(kiroToolDisplay('execute_bash', { command: 'ls -la\nmore' }, update('execute'))).toEqual(
      { kind: 'shell', command: 'ls -la\nmore', summary: 'ls -la' },
    );
    expect(
      kiroToolDisplay(
        'fs_read',
        { operations: [{ mode: 'Line', path: 'a.ts' }, { path: 'b.ts' }] },
        update('read'),
      ),
    ).toEqual({ kind: 'read', paths: ['a.ts', 'b.ts'], summary: 'a.ts' });
    expect(kiroToolDisplay('fs_write', { path: 'c.ts' }, update('edit'))).toEqual({
      kind: 'write',
      paths: ['c.ts'],
      summary: 'c.ts',
    });
    expect(kiroToolDisplay('grep', { pattern: 'TODO' }, update('search'))).toEqual({
      kind: 'search',
      query: 'TODO',
      summary: 'TODO',
    });
    expect(kiroToolDisplay('web_fetch', { url: 'https://kiro.dev' }, update('fetch'))).toEqual({
      kind: 'fetch',
      url: 'https://kiro.dev',
      summary: 'https://kiro.dev',
    });
    expect(kiroToolDisplay('use_subagent', { task: 'review' }, update('other'))).toEqual({
      kind: 'sub_agent',
      summary: 'review',
    });
    expect(
      kiroToolDisplay('Editing file', {}, update('edit', { locations: [{ path: 'd.ts' }] })),
    ).toEqual({ kind: 'edit', paths: ['d.ts'], summary: 'd.ts' });
    expect(kiroToolDisplay('@github/search', {}, update('other'))).toEqual({
      kind: 'unknown',
      mcpServer: 'github',
      summary: '@github/search',
    });
    expect(kiroToolDisplay('mystery', {}, update('other'))).toEqual({ kind: 'unknown' });
  });
});

describe('启动', () => {
  it('从 `kiro-cli --version` 取版本', () => {
    expect(parseKiroVersion('kiro-cli 2.36.0\n')).toBe('2.36.0');
    expect(parseKiroVersion('kiro-cli dev')).toBeUndefined();
  });
  it('安装与登录命令；ACP 固定 v2 引擎；Wevir 装的那份不自更新', () => {
    expect(kiroInstallCommand('darwin')).toBe('curl -fsSL https://cli.kiro.dev/install | bash');
    expect(kiroInstallCommand('win32')).toBe('irm https://cli.kiro.dev/install.ps1 | iex');
    expect(kiroLoginCommand('/x/kiro-cli', true)).toBe('"/x/kiro-cli" login');
    expect(kiroLoginCommand('/usr/local/bin/kiro-cli', false)).toBe('kiro-cli login');
    expect(KIRO_ACP_ARGS).toEqual(['acp', '--agent-engine', 'v2']);
    expect(managedKiroEnv({ A: '1' })).toEqual({ A: '1', KIRO_NO_AUTO_UPDATE: '1' });
    expect(kiroApiKeyEnv({ KIRO_API_KEY: ' ' })).toBe(false);
    expect(kiroApiKeyEnv({ KIRO_API_KEY: 'k' })).toBe(true);
  });
  it('常见目录含官方脚本与 macOS 程序包的位置，Windows 只找 PATH', () => {
    expect(commonKiroDirs('/h', 'darwin')).toEqual([
      '/h/.local/bin',
      '/usr/local/bin',
      '/Applications/Kiro CLI.app/Contents/MacOS',
    ]);
    expect(commonKiroDirs('/h', 'linux')).toEqual(['/h/.local/bin', '/usr/local/bin']);
    expect(commonKiroDirs('C:\\Users\\me', 'win32')).toEqual([]);
  });
  it('环境：PATH 前加 kiro-cli 所在目录，后补存在的常见目录，保留 API Key 与代理', () => {
    const parent = { PATH: '/usr/bin', KIRO_API_KEY: 'k', HTTPS_PROXY: 'http://proxy' };
    const env = kiroEnv(
      parent,
      '/opt/kiro/kiro-cli',
      'linux',
      '/h',
      (dir) => dir === '/h/.local/bin',
    );
    expect(env).toEqual({ ...parent, PATH: '/opt/kiro:/usr/bin:/h/.local/bin' });
    const windows = kiroEnv({ Path: 'C:\\bin' }, 'C:\\kiro\\kiro-cli.exe', 'win32', 'C:\\h');
    expect(windows).toEqual({ PATH: 'C:\\kiro;C:\\bin' });
  });
  it('显式的路径无效时报错，不退回 PATH；都没有时用 Wevir 装的', () => {
    expect(() => findKiro({ customPath: '/nowhere/kiro-cli', env: { PATH: '' } })).toThrow();
    const managed = join(import.meta.dirname, 'test-fixtures', 'fake-kiro.mjs');
    expect(
      findKiro({
        env: { PATH: '' },
        home: '/nonexistent-home',
        platform: 'linux',
        managedPath: managed,
      }),
    ).toEqual({ path: managed, source: 'component' });
  });
});
