// Grok 账号的检测（grok-event-mapping.md §2）：假 grok 回答 `--version`、`grok models` 与只做 initialize 的 ACP 探测。

import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GrokAccounts, PROBE_TTL_MS } from './accounts.js';
import {
  FAKE_GROK,
  fakeGrokEnv,
  readLog,
  readTranscript,
  tempRoot,
} from './test-fixtures/harness.js';

const temp = tempRoot('accounts');
afterAll(() => temp.remove());

let seq = 0;
function accounts(extra: Record<string, string> = {}, options: { now?: () => number } = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'grok.log');
  const subject = new GrokAccounts({
    workDir: join(dir, 'engines', 'grok'),
    env: fakeGrokEnv({ FAKE_GROK_LOG: log, ...extra }),
    ...options,
  });
  return { subject, log };
}

describe('GrokAccounts', () => {
  it('已登录：版本、模型与推理档位来自 initialize 的 modelState；探测不认证、不建会话', async () => {
    const { subject, log } = accounts();
    const changes: string[] = [];
    subject.onChange((state) => changes.push(state.status));
    const state = await subject.read('grok');
    expect(state).toEqual({
      kind: 'grok',
      status: 'signed_in',
      signIn: 'command',
      loginCommand: 'grok login',
      installed: true,
      executablePath: FAKE_GROK,
      version: '1.0.41',
    });
    expect(changes).toEqual(['signed_in']);
    const models = await subject.models('grok');
    expect(models.defaultModelId).toBe('grok-4.7');
    expect(models.models.map((model) => model.id)).toEqual([
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
      'grok-4.5',
    ]);
    expect(models.models[0]).toEqual({
      id: 'grok-4.7',
      displayName: 'Grok 4.7',
      contextWindow: 500_000,
      reasoningEfforts: ['xhigh', 'high', 'medium', 'low'],
    });
    expect(readLog(log).map((message) => message.method)).toEqual(['initialize']);
    subject.dispose();
  });

  it('grok models 说没登录：signed_out，executable() 报 missing_credentials', async () => {
    const { subject } = accounts({
      FAKE_GROK_MODELS: 'You are not logged in. Run `grok login`.\n',
    });
    const state = await subject.read('grok');
    expect(state).toMatchObject({ status: 'signed_out', installed: true, version: '1.0.41' });
    await expect(subject.executable()).rejects.toMatchObject({ code: 'missing_credentials' });
    subject.dispose();
  });

  it('XAI_API_KEY：算已登录（API Key），不管 grok models 怎么说', async () => {
    const { subject } = accounts({
      XAI_API_KEY: 'xai-test',
      FAKE_GROK_MODELS: 'You are not logged in.\n',
    });
    expect(await subject.read('grok')).toMatchObject({
      status: 'signed_in',
      plan: 'apiKey',
      planLabel: 'xAI API Key',
    });
    subject.dispose();
  });

  it('看不出有没有登录：当作已登录并说明；grok models 失败时模型来自 initialize', async () => {
    const { subject } = accounts({
      FAKE_GROK_MODELS: 'usage: grok …\n',
      FAKE_GROK_MODELS_EXIT: '2',
    });
    expect(await subject.read('grok')).toMatchObject({
      status: 'signed_in',
      lastError: 'Could not confirm the Grok login from `grok models`',
    });
    expect((await subject.models('grok')).defaultModelId).toBe('grok-4.7');
    subject.dispose();
  });

  it('没装：installed false 与安装命令；指定的路径不对时说明', async () => {
    const env = fakeGrokEnv({ PATH: temp.dir('empty-path') });
    delete env.WEVIR_GROK_BIN;
    const subject = new GrokAccounts({
      workDir: temp.dir('not-installed'),
      env,
      findExecutable: () => {
        throw new Error('not found');
      },
    });
    expect(await subject.read('grok')).toEqual({
      kind: 'grok',
      status: 'signed_out',
      signIn: 'command',
      loginCommand: 'grok login',
      installed: false,
      installCommand: 'npm install -g @xai-official/grok',
    });
    await expect(subject.executable()).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(await subject.setExecutablePath('grok', '/nowhere/grok')).toMatchObject({
      installed: false,
      customPath: '/nowhere/grok',
      lastError: '/nowhere/grok does not exist or is not executable',
    });
    subject.dispose();
  });

  it('setExecutablePath 重新检测并用指定的路径；null 回到自动查找', async () => {
    const seen: Array<string | null> = [];
    const subject = new GrokAccounts({
      workDir: temp.dir('custom'),
      env: fakeGrokEnv(),
      findExecutable: (custom) => {
        seen.push(custom);
        return FAKE_GROK;
      },
      probeInitialize: async () => undefined,
    });
    expect(await subject.setExecutablePath('grok', ' ~/bin/grok ')).toMatchObject({
      customPath: '~/bin/grok',
      status: 'signed_in',
    });
    expect((await subject.setExecutablePath('grok', null)).customPath).toBeUndefined();
    expect(seen).toEqual(['~/bin/grok', null]);
    // initialize 探测失败时用 grok models 的列表。
    expect((await subject.models('grok')).models.map((model) => model.id)).toEqual([
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
    ]);
    subject.dispose();
  });

  it('结果缓存 5 分钟，refresh 重新检测；登录与登出交给终端', async () => {
    let now = 1_000;
    let probes = 0;
    const subject = new GrokAccounts({
      workDir: temp.dir('cache'),
      env: fakeGrokEnv(),
      probeInitialize: async () => {
        probes += 1;
        return readTranscript('simple').find(
          (entry) => entry.frame?.method === 'initialize' && entry.frame.kind === 'response',
        )?.frame?.result;
      },
      now: () => now,
    });
    await subject.read('grok');
    await subject.read('grok');
    expect(probes).toBe(1);
    now += PROBE_TTL_MS;
    await subject.read('grok');
    expect(probes).toBe(2);
    await subject.read('grok', { refresh: true });
    expect(probes).toBe(3);
    await expect(subject.login('grok')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(subject.logout('grok')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(subject.read('claude')).rejects.toMatchObject({ code: 'invalid_input' });
    subject.markSignedOut('Authentication required');
    expect(await subject.read('grok')).toMatchObject({ status: 'signed_in' });
    subject.dispose();
    await expect(subject.read('grok')).rejects.toMatchObject({ code: 'disposed' });
  });
});
