// Grok 账号的检测（grok-event-mapping.md §2）：假 grok 回答 `--version`、`grok models` 与只做 initialize 的 ACP 探测。

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import {
  type ManagedExecutable,
  NpmInstallCancelled,
  type NpmInstallProgress,
  type NpmPackageInstaller,
} from '@wevir/runtime-adapter/npm-package';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GrokAccounts, type GrokAccountsOptions, PROBE_TTL_MS } from './accounts.js';
import { GROK_INSTALL_COMMAND } from './launch.js';
import type { GrokLoginFlow, GrokLoginResult } from './login.js';
import {
  FAKE_GROK,
  fakeGrokEnv,
  readEnvLog,
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

/** `FAKE_GROK_ARGV_LOG` 里 `grok models` 跑了几次。 */
function modelRuns(file: string): number {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => (JSON.parse(line) as string[])[0] === 'models').length;
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
      signIn: 'in_app',
      loginMethods: ['device_code'],
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

  it('grok models 说没登录时再问一次：令牌过期刷新后第二次说已登录就算已登录；两次都说没登录才是 signed_out', async () => {
    const dir = temp.dir(`once-${seq + 1}`);
    const once = join(dir, 'models-once.txt');
    writeFileSync(once, 'You are not authenticated.\n');
    const argv = join(dir, 'argv.ndjson');
    const refreshed = accounts({ FAKE_GROK_MODELS_ONCE: once, FAKE_GROK_ARGV_LOG: argv });
    expect(await refreshed.subject.read('grok')).toMatchObject({ status: 'signed_in' });
    expect(await refreshed.subject.read('grok')).not.toHaveProperty('lastError');
    expect(modelRuns(argv)).toBe(2);
    refreshed.subject.dispose();

    const argv2 = join(dir, 'argv2.ndjson');
    const out = accounts({
      FAKE_GROK_MODELS: 'You are not logged in. Run `grok login`.\n',
      FAKE_GROK_ARGV_LOG: argv2,
    });
    expect(await out.subject.read('grok')).toMatchObject({ status: 'signed_out' });
    expect(modelRuns(argv2)).toBe(2);
    out.subject.dispose();
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
      installer: null,
      findExecutable: () => {
        throw new Error('not found');
      },
    });
    expect(await subject.read('grok')).toEqual({
      kind: 'grok',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
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

  it('结果缓存 5 分钟，refresh 重新检测', async () => {
    let now = 1_000;
    let probes = 0;
    const subject = new GrokAccounts({
      workDir: temp.dir('cache'),
      env: fakeGrokEnv(),
      installer: null,
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
    await expect(subject.read('claude')).rejects.toMatchObject({ code: 'invalid_input' });
    subject.markSignedOut('Authentication required');
    expect(await subject.read('grok')).toMatchObject({ status: 'signed_in' });
    subject.dispose();
    await expect(subject.read('grok')).rejects.toMatchObject({ code: 'disposed' });
  });
});

describe('GrokAccounts：下载安装与应用内登录', () => {
  const posix = process.platform === 'win32' ? it.skip : it;
  const MANAGED: ManagedExecutable = { path: FAKE_GROK, version: '1.0.62' };
  const SIGNED_IN =
    'You are logged in with grok.com.\nDefault model: grok-4.7\n  * grok-4.7 (default)\n';
  const SIGNED_OUT =
    'You are not authenticated.\n\nDefault model: grok-4.6\n  * grok-4.6 (default)\n';

  /** 受控的安装器：测试决定什么时候给进度、什么时候结束。 */
  function controlledInstaller(
    initial?: ManagedExecutable,
    installed: ManagedExecutable = MANAGED,
  ) {
    let active = initial;
    let onProgress: (progress: NpmInstallProgress) => void = () => {};
    let settle: (result: 'ok' | Error) => void = () => {};
    const state = { installing: false, started: 0, cancelled: 0 };
    const installer = {
      get installing() {
        return state.installing;
      },
      active: async () => active,
      install(callback: (progress: NpmInstallProgress) => void) {
        state.installing = true;
        state.started += 1;
        onProgress = callback;
        return new Promise<ManagedExecutable>((resolve, reject) => {
          settle = (result) => {
            state.installing = false;
            if (result instanceof Error) {
              reject(result);
              return;
            }
            active = installed;
            resolve(installed);
          };
        });
      },
      cancel() {
        state.cancelled += 1;
      },
    };
    return {
      installer: installer as unknown as NpmPackageInstaller,
      state,
      progress: (progress: NpmInstallProgress) => onProgress(progress),
      finish: (result: 'ok' | Error) => settle(result),
    };
  }

  /** 找不到用户自己的 `grok`：只认 Wevir 装的。 */
  const onlyManaged: GrokAccountsOptions['findExecutable'] = (_custom, managed) => {
    if (managed === undefined) throw new Error('not found');
    return managed;
  };

  let counter = 0;
  function make(options: Partial<GrokAccountsOptions> = {}, signedIn = false) {
    counter += 1;
    const dir = temp.dir(`flow-${counter}`);
    const modelsFile = join(dir, 'models.txt');
    const envLog = join(dir, 'env.log');
    writeFileSync(modelsFile, signedIn ? SIGNED_IN : SIGNED_OUT);
    // 不指定路径：只靠 findExecutable 的替身（WEVIR_GROK_BIN 指错时 lastError 会带原文）。
    const { WEVIR_GROK_BIN: _bin, ...env } = fakeGrokEnv({
      FAKE_GROK_MODELS_FILE: modelsFile,
      FAKE_GROK_ENV_LOG: envLog,
    });
    const created = new GrokAccounts({
      workDir: join(dir, 'engines', 'grok'),
      env,
      findExecutable: onlyManaged,
      probeInitialize: async () => undefined,
      ...options,
    });
    const seen: AccountState[] = [];
    created.onChange((state) => seen.push(state));
    return {
      created,
      seen,
      envLog,
      signIn: () => writeFileSync(modelsFile, SIGNED_IN),
      signOut: () => writeFileSync(modelsFile, SIGNED_OUT),
    };
  }

  /** 假的 `grok login --device-auth`：测试决定什么时候退出。 */
  function loginFlow(options: { browserOpened?: boolean; code?: string } = {}) {
    let finish: (result: GrokLoginResult) => void = () => {};
    const done = new Promise<GrokLoginResult>((resolve) => {
      finish = resolve;
    });
    const flow: GrokLoginFlow = {
      verificationUrl: `https://accounts.x.ai/oauth2/device?user_code=${options.code ?? 'AAAA-BBBB'}`,
      userCode: options.code ?? 'AAAA-BBBB',
      browserOpened: options.browserOpened ?? true,
      done,
      cancel: vi.fn(() => finish({ ok: false, cancelled: true, message: 'cancelled' })),
    };
    return { flow, finish };
  }

  it('没装：带下载（canInstall）和自己安装的命令；没有本平台的包时不给下载', async () => {
    const { installer } = controlledInstaller();
    const { created } = make({ installer });
    expect(await created.read('grok')).toEqual({
      kind: 'grok',
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['device_code'],
      installed: false,
      installCommand: GROK_INSTALL_COMMAND,
      canInstall: true,
    });
    const { created: unsupported } = make({ installer: null });
    expect((await unsupported.read('grok')).canInstall).toBeUndefined();
    await expect(unsupported.install('grok')).rejects.toMatchObject({ code: 'invalid_input' });
    created.dispose();
    unsupported.dispose();
  });

  it('下载安装：先报 installing 和进度，装好后重新检测，找到装好的那份', async () => {
    const control = controlledInstaller();
    const { created, seen } = make({ installer: control.installer });
    expect(await created.read('grok')).toMatchObject({ installed: false, canInstall: true });

    const started = await created.install('grok');
    expect(started).toMatchObject({ installed: false, installing: { completedBytes: 0 } });
    expect(await created.install('grok')).toMatchObject({ installing: expect.anything() });
    expect(control.state.started).toBe(1);

    control.progress({ phase: 'downloading', completedBytes: 1024, totalBytes: 4096 });
    expect(seen.at(-1)?.installing).toEqual({ completedBytes: 1024, totalBytes: 4096 });

    control.finish('ok');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: true,
        executablePath: MANAGED.path,
        status: 'signed_out',
      }),
    );
    expect(seen.at(-1)?.installing).toBeUndefined();
    expect(seen.at(-1)?.canInstall).toBeUndefined();
    created.dispose();
  });

  it('下载失败：原因进 lastError，仍可再下；重新检测后清掉；取消不算失败', async () => {
    const control = controlledInstaller();
    const { created, seen } = make({ installer: control.installer });
    await created.read('grok');
    await created.install('grok');
    control.finish(new Error('Could not reach the npm registry'));
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: false,
        canInstall: true,
        lastError: 'Could not reach the npm registry',
      }),
    );
    expect(seen.at(-1)?.installing).toBeUndefined();
    expect(await created.read('grok')).toMatchObject({
      lastError: 'Could not reach the npm registry',
    });
    expect((await created.read('grok', { refresh: true })).lastError).toBeUndefined();

    await created.install('grok');
    control.finish(new NpmInstallCancelled('Installation cancelled.'));
    await vi.waitFor(() => expect(seen.at(-1)?.installing).toBeUndefined());
    expect(seen.at(-1)?.lastError).toBeUndefined();
    created.dispose();
  });

  posix(
    'Wevir 装的那份跑不起来：当作没装，可以重新下载；用户自己的跑不起来照旧是 installed',
    async () => {
      const dir = temp.dir('broken');
      const broken = join(dir, 'grok');
      writeFileSync(broken, '#!/bin/sh\nexit 3\n');
      chmodSync(broken, 0o755);
      const { installer } = controlledInstaller({ path: broken, version: '1.0.62' });
      const { created } = make({ installer });
      expect(await created.read('grok')).toMatchObject({
        installed: false,
        canInstall: true,
        executablePath: broken,
        lastError: '`grok --version` exited with code 3',
      });
      const { created: own } = make({ installer: null, findExecutable: () => broken });
      const state = await own.read('grok');
      expect(state).toMatchObject({ installed: true, executablePath: broken });
      expect(state.canInstall).toBeUndefined();
      created.dispose();
      own.dispose();
    },
  );

  it('Wevir 装的 grok 带 GROK_DISABLE_AUTOUPDATER=1（更新只经设置里的下载）；用户自己的不动', async () => {
    const { installer } = controlledInstaller(MANAGED);
    const managed = make({ installer });
    await managed.created.read('grok');
    const logged = (file: string) => readEnvLog(file).map((entry) => entry.autoupdater);
    expect(logged(managed.envLog)).not.toHaveLength(0);
    expect(new Set(logged(managed.envLog))).toEqual(new Set(['1']));
    managed.created.dispose();

    const own = make({ installer: null, findExecutable: () => FAKE_GROK });
    await own.created.read('grok');
    expect(new Set(logged(own.envLog))).toEqual(new Set([null]));
    own.created.dispose();
  });

  it('应用内登录：signing_in 带地址与码，grok 已开浏览器时没有 authUrl；完成后重新检测成 signed_in', async () => {
    const { flow, finish } = loginFlow();
    const startLogin = vi.fn(async () => flow);
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen, signIn } = make({ installer, startLogin });
    expect(await created.read('grok')).toMatchObject({ status: 'signed_out', installed: true });

    const state = await created.login('grok');
    expect(state).toMatchObject({
      status: 'signing_in',
      login: {
        method: 'device_code',
        verificationUrl: flow.verificationUrl,
        userCode: 'AAAA-BBBB',
      },
    });
    expect(state.login?.authUrl).toBeUndefined();
    expect(startLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: MANAGED.path,
        env: expect.objectContaining({ GROK_DISABLE_AUTOUPDATER: '1' }),
      }),
    );
    expect(await created.read('grok')).toMatchObject({ status: 'signing_in' });

    signIn();
    finish({ ok: true });
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ status: 'signed_in' }));
    expect(seen.at(-1)?.login).toBeUndefined();
    created.dispose();
  });

  it('grok 打不开浏览器：login.authUrl 给地址，桌面端替它打开', async () => {
    const { flow } = loginFlow({ browserOpened: false, code: 'CCCC-DDDD' });
    const { installer } = controlledInstaller(MANAGED);
    const { created } = make({ installer, startLogin: async () => flow });
    const state = await created.login('grok');
    expect(state.login).toMatchObject({
      method: 'device_code',
      authUrl: flow.verificationUrl,
      verificationUrl: flow.verificationUrl,
      userCode: 'CCCC-DDDD',
    });
    created.dispose();
  });

  it('登录失败：回到 signed_out，带 grok 的输出', async () => {
    const { flow, finish } = loginFlow();
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen } = make({ installer, startLogin: async () => flow });
    await created.login('grok');
    finish({ ok: false, cancelled: false, message: 'Authorization was denied.' });
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        status: 'signed_out',
        lastError: 'Authorization was denied.',
      }),
    );
    expect(seen.at(-1)?.login).toBeUndefined();
    created.dispose();
  });

  it('取消登录：停掉 grok，回到 signed_out，没有错误；新的登录替换旧的', async () => {
    const first = loginFlow({ code: '1111-1111' });
    const second = loginFlow({ code: '2222-2222' });
    const third = loginFlow({ code: '3333-3333' });
    const flows = [first.flow, second.flow, third.flow];
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen } = make({
      installer,
      startLogin: async () => flows.shift() as GrokLoginFlow,
    });
    const started = await created.login('grok');
    const cancelled = await created.cancelLogin('grok', started.login?.loginId);
    expect(first.flow.cancel).toHaveBeenCalled();
    expect(cancelled).toMatchObject({ status: 'signed_out' });
    expect(cancelled.lastError).toBeUndefined();

    await created.login('grok');
    const replaced = await created.login('grok');
    expect(second.flow.cancel).toHaveBeenCalledTimes(1);
    expect(replaced.login?.userCode).toBe('3333-3333');
    // 被换掉的流程退出（cancel 让它兑现 cancelled）不影响现在的状态。
    await Promise.resolve();
    expect(seen.at(-1)?.status).toBe('signing_in');
    expect(seen.at(-1)?.login?.userCode).toBe('3333-3333');
    // loginId 不是当前的：什么都不做。
    expect((await created.cancelLogin('grok', 'other')).status).toBe('signing_in');
    created.dispose();
  });

  it('不能登录的情形：没装、启动不了', async () => {
    const { created } = make({ installer: controlledInstaller().installer });
    await expect(created.login('grok')).rejects.toMatchObject({ code: 'engine_unavailable' });
    const { installer } = controlledInstaller(MANAGED);
    const { created: broken } = make({
      installer,
      startLogin: async () => {
        throw new Error('grok did not report a sign-in address within 20 s');
      },
    });
    await expect(broken.login('grok')).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('did not report a sign-in address'),
    });
    expect((await broken.read('grok')).status).toBe('signed_out');
    created.dispose();
    broken.dispose();
  });

  it('应用内登出：跑 grok logout，再检测', async () => {
    const { installer } = controlledInstaller(MANAGED);
    const { created, envLog } = make({ installer }, true);
    expect(await created.read('grok')).toMatchObject({ status: 'signed_in' });
    expect(await created.logout('grok')).toMatchObject({ status: 'signed_out' });
    expect(readEnvLog(envLog).some((entry) => entry.argv[0] === 'logout')).toBe(true);

    const { created: failing } = make({
      installer,
      runCommand: async () => ({
        ok: false as const,
        reason: 'failed' as const,
        message: 'not logged in',
      }),
    });
    await expect(failing.logout('grok')).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: 'not logged in',
    });
    const { created: nonzero } = make({
      installer,
      runCommand: async () => ({ ok: true as const, stdout: '', stderr: 'boom', code: 1 }),
    });
    await expect(nonzero.logout('grok')).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('boom'),
    });
    created.dispose();
    failing.dispose();
    nonzero.dispose();
  });

  it('没登录时 executable() 提示去设置里登录；dispose：取消安装与登录', async () => {
    const control = controlledInstaller();
    const { flow } = loginFlow();
    const { created } = make({
      installer: control.installer,
      startLogin: async () => flow,
      findExecutable: () => FAKE_GROK,
    });
    await expect(created.executable()).rejects.toMatchObject({
      code: 'missing_credentials',
      message: expect.stringContaining('sign in from Settings'),
    });
    await created.login('grok');
    created.dispose();
    expect(flow.cancel).toHaveBeenCalled();
    expect(control.state.cancelled).toBe(1);
  });
});
