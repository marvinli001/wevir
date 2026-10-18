import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PROBE_TTL_MS, WorkBuddyAccounts } from './accounts.js';
import { WORKBUDDY_DEFAULT_MODELS } from './models.js';
import {
  FAKE_WORKBUDDY,
  fakeWorkBuddyEnv,
  readLog,
  readSample,
  tempRoot,
} from './test-fixtures/harness.js';

const temp = tempRoot('accounts');
afterAll(() => temp.remove());
const subjects: WorkBuddyAccounts[] = [];
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((subject) => subject.dispose()));
});
let seq = 0;
function setup(extra: Record<string, string> = {}) {
  const dir = temp.dir(`case-${++seq}`);
  const log = join(dir, 'messages.ndjson');
  const subject = new WorkBuddyAccounts({
    workDir: dir,
    env: fakeWorkBuddyEnv({ FAKE_WORKBUDDY_LOG: log, ...extra }),
  });
  subjects.push(subject);
  return { subject, log };
}

describe('WorkBuddyAccounts', () => {
  it('已登录：版本和动态模型；只 initialize 和空 session/new，不认证、不读用户信息', async () => {
    const { subject, log } = setup();
    expect(await subject.read('workbuddy')).toEqual({
      kind: 'workbuddy',
      status: 'signed_in',
      signIn: 'command',
      loginCommand: 'codebuddy',
      installed: true,
      executablePath: FAKE_WORKBUDDY,
      version: '2.168.2',
    });
    expect((await subject.models('workbuddy')).models).toHaveLength(2);
    expect(readLog(log).map((message) => message.method)).toEqual(['initialize', 'session/new']);
    expect(readLog(log)[0]?.params.clientCapabilities).toEqual({});
    expect(readLog(log)[1]?.params.mcpServers).toEqual([]);
  });
  it('未登录时给命令与环境一致的指引，没有 authenticate 或 OAuth', async () => {
    const { subject, log } = setup({ FAKE_WORKBUDDY_SIGNED_OUT: '1' });
    expect(await subject.read('workbuddy')).toMatchObject({
      status: 'signed_out',
      installed: true,
      lastError: expect.stringContaining('China/international'),
    });
    expect(await subject.models('workbuddy')).toEqual(WORKBUDDY_DEFAULT_MODELS);
    await expect(subject.executable()).rejects.toMatchObject({ code: 'missing_credentials' });
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
  });
  it('未装与错误路径；设置路径和清除路径都重新检测', async () => {
    const seen: Array<string | null> = [];
    const subject = new WorkBuddyAccounts({
      workDir: temp.dir('paths'),
      env: fakeWorkBuddyEnv(),
      findExecutable: (path) => {
        seen.push(path);
        if (path !== FAKE_WORKBUDDY) throw new Error('missing');
        return FAKE_WORKBUDDY;
      },
    });
    subjects.push(subject);
    expect(await subject.read('workbuddy')).toMatchObject({
      installed: false,
      installCommand: 'npm install -g @tencent-ai/codebuddy-code',
    });
    await expect(subject.executable()).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(await subject.setExecutablePath('workbuddy', ` ${FAKE_WORKBUDDY} `)).toMatchObject({
      status: 'signed_in',
      customPath: FAKE_WORKBUDDY,
    });
    expect(await subject.setExecutablePath('workbuddy', null)).toMatchObject({ installed: false });
    expect(seen).toEqual([null, FAKE_WORKBUDDY, null]);
  });
  it('版本解析失败时 ACP 仍可检测；协议或命令失败降级而不回显输出', async () => {
    const { subject } = setup({ FAKE_WORKBUDDY_VERSION: 'unrecognized fixture' });
    expect(await subject.read('workbuddy')).toMatchObject({
      status: 'signed_in',
      lastError: expect.stringContaining('Unrecognized'),
    });
    const failed = setup({ FAKE_WORKBUDDY_PROBE_ERROR: '1' }).subject;
    expect(await failed.read('workbuddy')).toMatchObject({
      installed: true,
      status: 'signed_out',
      lastError: expect.stringContaining('ACP detection failed'),
    });
    const badVersion = setup({ FAKE_WORKBUDDY_VERSION_EXIT: '2' }).subject;
    expect(await badVersion.read('workbuddy')).toMatchObject({
      installed: true,
      status: 'signed_out',
    });
    expect(await badVersion.models('workbuddy')).toEqual(WORKBUDDY_DEFAULT_MODELS);
  });
  it('没有模型元数据时只给 Auto，不猜推理档位或额度', async () => {
    const { subject } = setup({ FAKE_WORKBUDDY_NO_MODELS: '1' });
    const state = await subject.read('workbuddy');
    expect(await subject.models('workbuddy')).toEqual(WORKBUDDY_DEFAULT_MODELS);
    expect(state.rateLimits).toBeUndefined();
    expect(state.email).toBeUndefined();
    expect(state.plan).toBeUndefined();
  });
  it('五分钟缓存、refresh、路径刷新；终端登录和登出不在 Wevir 执行', async () => {
    let now = 1;
    let probes = 0;
    const subject = new WorkBuddyAccounts({
      workDir: temp.dir('cache'),
      env: fakeWorkBuddyEnv(),
      now: () => now,
      probeSession: async () => {
        probes++;
        return readSample('configOptions');
      },
    });
    subjects.push(subject);
    await subject.read('workbuddy');
    await subject.read('workbuddy');
    expect(probes).toBe(1);
    now += PROBE_TTL_MS;
    await subject.read('workbuddy');
    expect(probes).toBe(2);
    await subject.read('workbuddy', { refresh: true });
    expect(probes).toBe(3);
    await subject.setExecutablePath('workbuddy', null);
    expect(probes).toBe(4);
    await expect(subject.login('workbuddy')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(subject.logout('workbuddy')).rejects.toMatchObject({ code: 'invalid_input' });
    subject.markSignedOut();
    expect(await subject.read('workbuddy')).toMatchObject({ status: 'signed_out' });
    await subject.dispose();
    expect(() => subject.read('workbuddy')).toThrow('disposed');
  });
});
