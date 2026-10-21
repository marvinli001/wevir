import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDevinResumeError, classifyDevinTurnError, isDevinAuthRequired } from './engine.js';
import {
  commonDevinDirs,
  devinEnv,
  devinLoginCommand,
  findDevin,
  parseDevinVersion,
} from './launch.js';
import { devinModels } from './models.js';
import { readSample } from './test-fixtures/harness.js';
import { devinToolDisplay } from './tool-display.js';

describe('错误归类（3000.11.92 的原文）', () => {
  it('没登录', () => {
    const error = readSample('authError');
    expect(isDevinAuthRequired(error)).toBe(true);
    expect(classifyDevinTurnError(error)).toMatchObject({
      category: 'missing_credentials',
      code: -32000,
    });
    expect(isDevinAuthRequired({ code: -32603, message: 'Unexpected failure' })).toBe(false);
  });
  it('额度与限流', () => {
    expect(
      classifyDevinTurnError({
        code: -32603,
        message: 'x',
        data: { details: 'Out of ACUs for this billing cycle' },
      }),
    ).toMatchObject({ category: 'provider', message: 'Out of ACUs for this billing cycle' });
  });
  it('session/load 找不到会话是 lost，其余 unknown', () => {
    expect(classifyDevinResumeError(readSample('notFound'))).toMatchObject({
      failure: { kind: 'lost', reason: 'not_found' },
      code: -32016,
    });
    expect(classifyDevinResumeError({ code: -32603, message: 'boom' }).failure).toEqual({
      kind: 'unknown',
    });
  });
});

describe('模型', () => {
  it('model 选项 → 模型列表，当前值是默认；没登录时选项为空就是 undefined', () => {
    const mode = readSample('modeOption');
    const model = readSample('modelOption') as Record<string, unknown>;
    expect(devinModels([mode, model])).toEqual({
      models: [
        { id: 'fixture-model-a', displayName: 'Fixture A' },
        { id: 'fixture-model-b', displayName: 'Fixture B' },
      ],
      defaultModelId: 'fixture-model-a',
    });
    expect(devinModels([mode, { ...model, options: [] }])).toBeUndefined();
    expect(devinModels(undefined)).toBeUndefined();
  });
});

describe('工具展示', () => {
  const update = (kind: string) =>
    ({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'x', kind }) as never;
  it('按 Devin 的工具名，认不出时按 ACP 的 kind', () => {
    expect(devinToolDisplay('exec', { command: 'ls -la\nmore' }, update('execute'))).toEqual({
      kind: 'shell',
      command: 'ls -la\nmore',
      summary: 'ls -la',
    });
    expect(devinToolDisplay('edit', { file_path: 'a.ts' }, update('edit'))).toEqual({
      kind: 'edit',
      paths: ['a.ts'],
      summary: 'a.ts',
    });
    expect(
      devinToolDisplay('Run tests', { command: 'pnpm test' }, update('execute')),
    ).toMatchObject({
      kind: 'shell',
      command: 'pnpm test',
    });
    expect(devinToolDisplay('mcp__github__search', {}, update('other'))).toEqual({
      kind: 'unknown',
      mcpServer: 'github',
      summary: 'mcp__github__search',
    });
  });
});

describe('启动', () => {
  it('从 `devin --version` 取版本', () => {
    expect(parseDevinVersion('devin 3000.11.92 (7f4e64980e22)\n')).toBe('3000.11.92');
    expect(parseDevinVersion('devin dev')).toBeUndefined();
  });
  it('Wevir 装的那份不在 PATH 里，终端命令写全路径', () => {
    expect(devinLoginCommand('/x/bin/devin', true)).toBe('"/x/bin/devin" auth login');
    expect(devinLoginCommand('/usr/local/bin/devin', false)).toBe('devin auth login');
  });
  it('常见目录含官方脚本与 Homebrew 的位置', () => {
    expect(commonDevinDirs('/h', 'darwin', {})).toEqual([
      '/h/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]);
    expect(
      commonDevinDirs('C:\\Users\\me', 'win32', {
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      })[0],
    ).toBe('C:\\Users\\me\\AppData\\Local\\devin\\cli\\bin');
  });
  it('环境：PATH 前加 devin 所在目录，后补存在的常见目录，保留用户的其他变量', () => {
    const env = devinEnv(
      { PATH: '/usr/bin', WINDSURF_API_KEY: 'k' },
      '/opt/devin/bin/devin',
      'darwin',
      '/h',
      (dir) => dir === '/opt/homebrew/bin',
    );
    expect(env.PATH).toBe('/opt/devin/bin:/usr/bin:/opt/homebrew/bin');
    expect(env.WINDSURF_API_KEY).toBe('k');
  });
  it('显式的路径无效时报错，不退回 PATH；都没有时用 Wevir 装的', () => {
    expect(() => findDevin({ customPath: '/nowhere/devin', env: { PATH: '' } })).toThrow();
    const managed = join(import.meta.dirname, 'test-fixtures', 'fake-devin.mjs');
    expect(
      findDevin({ env: { PATH: '' }, home: '/nonexistent-home', managedPath: managed }),
    ).toEqual({
      path: managed,
      source: 'component',
    });
  });
});
