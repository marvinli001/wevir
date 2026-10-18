import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyWorkBuddyResumeError, classifyWorkBuddyTurnError } from './engine.js';
import {
  commonWorkBuddyDirs,
  findWorkBuddy,
  parseWorkBuddyVersion,
  WorkBuddyLauncher,
  workbuddyEnv,
} from './launch.js';
import { nativeEffort, record, wevirEffort, workBuddyModels } from './models.js';
import { workBuddyQuestions } from './questions.js';
import { readSample, tempRoot } from './test-fixtures/harness.js';
import { workBuddyToolDisplay } from './tool-display.js';

const temp = tempRoot('units');
afterAll(() => temp.remove());

describe('官方 CLI 启动', () => {
  function executable(dir: string, command = 'codebuddy') {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, process.platform === 'win32' ? `${command}.cmd` : command);
    writeFileSync(file, 'fixture');
    chmodSync(file, 0o755);
    return file;
  }
  it('显式环境路径、设置、PATH、常见目录依次查找；错误路径不退回', () => {
    const home = temp.dir('home');
    const common = executable(join(home, '.local', 'bin'));
    const onPath = executable(temp.dir('path'));
    const configured = executable(temp.dir('configured'));
    const override = executable(temp.dir('override'));
    const env = { PATH: temp.dir('path'), WEVIR_WORKBUDDY_BIN: override };
    expect(findWorkBuddy({ home, env, customPath: configured }).path).toBe(override);
    delete (env as Partial<typeof env>).WEVIR_WORKBUDDY_BIN;
    expect(findWorkBuddy({ home, env, customPath: configured }).path).toBe(configured);
    expect(findWorkBuddy({ home, env }).path).toBe(onPath);
    expect(findWorkBuddy({ home, env: { PATH: '' } }).path).toBe(common);
    expect(() => findWorkBuddy({ home, env, customPath: '/missing/codebuddy' })).toThrow();
    expect(() =>
      findWorkBuddy({ home, env: { ...env, WEVIR_WORKBUDDY_BIN: '/missing/codebuddy' } }),
    ).toThrow();
    expect(
      findWorkBuddy({
        home,
        env: { PATH: '' },
        customPath: `~/.local/bin/codebuddy${process.platform === 'win32' ? '.cmd' : ''}`,
      }).path,
    ).toBe(common);
  });
  it('cbc 在 PATH 时先于常见目录的 codebuddy；Windows 包括 npm、pnpm、Volta', () => {
    const home = temp.dir('alias-home');
    executable(join(home, '.local', 'bin'));
    const cbc = executable(temp.dir('alias-path'), 'cbc');
    expect(findWorkBuddy({ home, env: { PATH: temp.dir('alias-path') } }).path).toBe(cbc);
    expect(
      commonWorkBuddyDirs('C:\\Users\\fixture', 'win32', {
        APPDATA: 'C:\\Roaming',
        LOCALAPPDATA: 'C:\\Local',
      }),
    ).toEqual(
      expect.arrayContaining([
        'C:\\Roaming\\npm',
        'C:\\Local\\pnpm',
        'C:\\Users\\fixture\\.volta\\bin',
      ]),
    );
  });
  it('只启动 --acp；保留用户 HOME 和已有的四项认证环境，不合成私有配置或沙箱开关', async () => {
    const parent = {
      HOME: '/fixture/home',
      PATH: '/usr/bin',
      CODEBUDDY_API_KEY: 'fixture-key',
      CODEBUDDY_AUTH_TOKEN: 'fixture-token',
      CODEBUDDY_BASE_URL: 'https://fixture.invalid',
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
      CODEBUDDY_IS_SANDBOX: '1',
    };
    const env = workbuddyEnv(
      parent,
      '/fixture/bin/codebuddy',
      'darwin',
      '/fixture/home',
      () => false,
    );
    expect(env).toMatchObject({
      HOME: parent.HOME,
      CODEBUDDY_API_KEY: parent.CODEBUDDY_API_KEY,
      CODEBUDDY_AUTH_TOKEN: parent.CODEBUDDY_AUTH_TOKEN,
      CODEBUDDY_BASE_URL: parent.CODEBUDDY_BASE_URL,
      CODEBUDDY_INTERNET_ENVIRONMENT: 'internal',
    });
    expect(env.PATH).toBe('/fixture/bin:/usr/bin');
    expect(env.CODEBUDDY_IS_SANDBOX).toBeUndefined();
    expect(env.CODEBUDDY_CONFIG_DIR).toBeUndefined();
    const workDir = temp.dir('engine');
    const spec = (
      await new WorkBuddyLauncher(workDir, async () => ({
        path: '/fixture/bin/codebuddy',
        env,
      })).prepare()
    ).spawnSpec();
    expect(spec.args).toEqual(['--acp']);
    expect(spec.options.cwd).toBe(workDir);
    expect(spec.options.env).toEqual(env);
    const empty = workbuddyEnv(
      {},
      '/fixture/bin/codebuddy',
      'darwin',
      '/fixture/home',
      () => false,
    );
    expect(empty.HOME).toBeUndefined();
    expect(empty.CODEBUDDY_AUTH_TOKEN).toBeUndefined();
    expect(parseWorkBuddyVersion('CodeBuddy 2.168.2-beta.1')).toBe('2.168.2-beta.1');
    expect(parseWorkBuddyVersion('unknown build')).toBeUndefined();
  });
});

describe('配置和工具', () => {
  it('模型分组展开、去重；当前模型才有实际档位，disabled 转 off，enabled 沿用默认', () => {
    const models = workBuddyModels(readSample('configOptions'));
    expect(models?.models).toEqual([
      {
        id: 'fixture-model-a',
        displayName: 'Fixture A',
        reasoningEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
      { id: 'fixture-model-b', displayName: 'Fixture B' },
    ]);
    expect(models?.defaultModelId).toBe('fixture-model-a');
    expect(workBuddyModels([{ id: 'model', type: 'select', options: [] }])).toBeUndefined();
    expect(nativeEffort('off')).toBe('disabled');
    expect(wevirEffort('enabled')).toBeUndefined();
    expect(wevirEffort('future')).toBeUndefined();
    expect(record(null)).toBeUndefined();
  });
  it.each([
    ['Bash', { command: 'echo ok' }, { kind: 'shell', command: 'echo ok' }],
    ['Read', { file_path: 'a.txt' }, { kind: 'read', paths: ['a.txt'] }],
    ['Write', { file_path: 'b.txt' }, { kind: 'write', paths: ['b.txt'] }],
    ['Edit', { file_path: 'b.txt' }, { kind: 'edit', paths: ['b.txt'] }],
    ['Grep', { pattern: 'fixture' }, { kind: 'search', query: 'fixture' }],
    [
      'WebFetch',
      { url: 'https://fixture.invalid' },
      { kind: 'fetch', url: 'https://fixture.invalid' },
    ],
    ['Task', { description: 'inspect' }, { kind: 'sub_agent', summary: 'inspect' }],
    ['TodoWrite', {}, { kind: 'plan' }],
    ['mcp__wevir__wevir_show', {}, { kind: 'unknown', mcpServer: 'wevir' }],
  ])('%s 的展示', (name, input, expected) => {
    expect(workBuddyToolDisplay(name, input, { sessionUpdate: 'tool_call' })).toMatchObject(
      expected,
    );
  });
  it('更新的工具名来自元数据，位置兜底；问题 ID、自由输入和多选保留', () => {
    expect(
      workBuddyToolDisplay(
        'Updated file',
        {},
        {
          sessionUpdate: 'tool_call_update',
          locations: [{ path: 'a.txt' }],
          _meta: { 'codebuddy.ai/toolName': 'Write' },
        },
      ),
    ).toMatchObject({ kind: 'write', paths: ['a.txt'] });
    expect(workBuddyQuestions(readSample('questionInput'))?.[0]).toMatchObject({
      id: 'q_0',
      allowOther: true,
      options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(
      workBuddyQuestions({ questions: [{ question: 'Malformed', options: [] }] }),
    ).toBeUndefined();
  });
  it('认证、额度、未知失败分开；恢复只把明确丢失的会话标为 lost', () => {
    expect(
      classifyWorkBuddyTurnError({ code: -32000, message: 'Authentication required' }).category,
    ).toBe('missing_credentials');
    expect(
      classifyWorkBuddyTurnError({
        code: -32603,
        message: 'Internal error',
        data: { details: '429 credit limit reached' },
      }),
    ).toMatchObject({ category: 'provider', message: '429 credit limit reached' });
    expect(classifyWorkBuddyTurnError(new Error('connection closed')).category).toBe('unknown');
    expect(classifyWorkBuddyResumeError(new Error('Session not found')).failure).toEqual({
      kind: 'lost',
      reason: 'not_found',
    });
    expect(classifyWorkBuddyResumeError(new Error('connection closed')).failure.kind).toBe(
      'unknown',
    );
  });
});
