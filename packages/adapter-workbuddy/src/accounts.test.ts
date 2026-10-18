import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PROBE_TTL_MS, WORKBUDDY_SIGN_IN_APP_HINT, WorkBuddyAccounts } from './accounts.js';
import { WorkBuddyInstaller } from './install.js';
import { startWorkBuddyLogin } from './login.js';
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
      signIn: 'in_app',
      loginMethods: ['browser'],
      installed: true,
      executablePath: FAKE_WORKBUDDY,
      version: '2.168.2',
    });
    expect((await subject.models('workbuddy')).models).toHaveLength(2);
    expect(readLog(log).map((message) => message.method)).toEqual(['initialize', 'session/new']);
    expect(readLog(log)[0]?.params.clientCapabilities).toEqual({});
    expect(readLog(log)[1]?.params.mcpServers).toEqual([]);
  });
  it('未登录：应用内能登录时只是未登录，检测从不 authenticate', async () => {
    const { subject, log } = setup({ FAKE_WORKBUDDY_SIGNED_OUT: '1' });
    const state = await subject.read('workbuddy');
    expect(state).toMatchObject({
      status: 'signed_out',
      signIn: 'in_app',
      loginMethods: ['browser'],
      loginOptions: [
        { id: 'internal', label: 'WeChat' },
        { id: 'external', label: 'Google / GitHub' },
      ],
      installed: true,
    });
    expect(state.lastError).toBeUndefined();
    expect(state.loginCommand).toBeUndefined();
    expect(await subject.models('workbuddy')).toEqual(WORKBUDDY_DEFAULT_MODELS);
    await expect(subject.executable()).rejects.toMatchObject({
      code: 'missing_credentials',
      message: WORKBUDDY_SIGN_IN_APP_HINT,
    });
    expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
  });
  it('继承了 CODEBUDDY_INTERNET_ENVIRONMENT 时只给对应的一种登录方式；已登录后不再给', async () => {
    for (const [environment, expected] of [
      ['internal', [{ id: 'internal', label: 'WeChat' }]],
      ['External', [{ id: 'external', label: 'Google / GitHub' }]],
    ] as const) {
      const { subject } = setup({
        FAKE_WORKBUDDY_SIGNED_OUT: '1',
        CODEBUDDY_INTERNET_ENVIRONMENT: environment,
      });
      expect((await subject.read('workbuddy')).loginOptions).toEqual(expected);
    }
    expect((await setup().subject.read('workbuddy')).loginOptions).toBeUndefined();
  });
  it('iOA、企业域名等环境应用内不登录：给命令与环境一致的指引', async () => {
    for (const environment of ['iOA', 'selfhosted', 'cloudhosted']) {
      const { subject, log } = setup({
        FAKE_WORKBUDDY_SIGNED_OUT: '1',
        CODEBUDDY_INTERNET_ENVIRONMENT: environment,
      });
      const state = await subject.read('workbuddy');
      expect(state).toMatchObject({
        status: 'signed_out',
        signIn: 'command',
        loginCommand: 'codebuddy',
        lastError: expect.stringContaining('China/international'),
      });
      expect(state.loginOptions).toBeUndefined();
      await expect(subject.login('workbuddy', 'browser')).rejects.toMatchObject({
        code: 'invalid_input',
      });
      await expect(subject.executable()).rejects.toMatchObject({
        code: 'missing_credentials',
        message: expect.stringContaining('terminal'),
      });
      expect(readLog(log).some((message) => message.method === 'authenticate')).toBe(false);
    }
  });
  it('未装与错误路径；设置路径和清除路径都重新检测', async () => {
    const seen: Array<string | null> = [];
    const subject = new WorkBuddyAccounts({
      workDir: temp.dir('paths'),
      env: fakeWorkBuddyEnv(),
      installer: null,
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
    expect((await subject.read('workbuddy')).canInstall).toBeUndefined();
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
  it('五分钟缓存、refresh、路径刷新；已登录时不登录，登出不在 Wevir 执行', async () => {
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
    // 已登录时绝不 authenticate（会先把人登出）。
    await expect(subject.login('workbuddy', 'browser')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(subject.logout('workbuddy')).rejects.toMatchObject({ code: 'invalid_input' });
    subject.markSignedOut();
    expect(await subject.read('workbuddy')).toMatchObject({ status: 'signed_out' });
    await subject.dispose();
    expect(() => subject.read('workbuddy')).toThrow('disposed');
  });
});

function until(
  subject: WorkBuddyAccounts,
  match: (state: AccountState) => boolean,
  timeoutMs = 15_000,
): Promise<AccountState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timed out waiting for the account state'));
    }, timeoutMs);
    const off = subject.onChange((state) => {
      if (!match(state)) return;
      clearTimeout(timer);
      off();
      resolve(state);
    });
  });
}

describe('应用内登录', () => {
  function loginSetup(extra: Record<string, string> = {}, urlWaitMs = 2_000) {
    const dir = temp.dir(`login-${++seq}`);
    const files = {
      done: join(dir, 'done'),
      state: join(dir, 'state'),
      auth: join(dir, 'auth.ndjson'),
      log: join(dir, 'messages.ndjson'),
    };
    const subject = new WorkBuddyAccounts({
      workDir: dir,
      env: fakeWorkBuddyEnv({
        FAKE_WORKBUDDY_SIGNED_OUT: '1',
        FAKE_WORKBUDDY_ALLOW_AUTH: '1',
        FAKE_WORKBUDDY_AUTH_STATE: files.state,
        FAKE_WORKBUDDY_AUTH_DONE: files.done,
        FAKE_WORKBUDDY_AUTH_LOG: files.auth,
        FAKE_WORKBUDDY_LOG: files.log,
        FAKE_WORKBUDDY_AUTH_URL: 'https://www.codebuddy.cn/login?state=abc',
        ...extra,
      }),
      startLogin: (input) => startWorkBuddyLogin({ ...input, urlWaitMs }),
    });
    subjects.push(subject);
    return { subject, files, dir };
  }
  const authCalls = (file: string) =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { methodId: string; browser: string | null })
      : [];

  it('authenticate 的登录地址交给调用方，用户同意后重新检测为已登录；CLI 自己不开浏览器', async () => {
    const { subject, files } = loginSetup();
    expect((await subject.read('workbuddy')).status).toBe('signed_out');
    const changes: AccountState[] = [];
    subject.onChange((state) => changes.push(state));
    const started = await subject.login('workbuddy', 'browser');
    expect(started).toMatchObject({
      status: 'signing_in',
      login: {
        method: 'browser',
        authUrl: 'https://www.codebuddy.cn/login?state=abc',
        loginId: expect.any(String),
      },
    });
    expect(started.lastError).toBeUndefined();
    expect(changes.at(-1)?.status).toBe('signing_in');
    // 登录进行中重新检测也还是“登录中”，不会被一次未登录的探测盖掉。
    expect((await subject.read('workbuddy', { refresh: true })).status).toBe('signing_in');

    const signedIn = until(subject, (state) => state.status === 'signed_in');
    writeFileSync(files.done, 'approved');
    const final = await signedIn;
    expect(final.login).toBeUndefined();
    expect(final.lastError).toBeUndefined();
    const calls = authCalls(files.auth);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.methodId).toBe('internal');
    expect(calls[0]?.browser).toMatch(/no-browser\.(?:sh|cmd)$/u);
    await expect(subject.executable()).resolves.toMatchObject({ path: FAKE_WORKBUDDY });
  });

  it('CODEBUDDY_INTERNET_ENVIRONMENT=external 走国际版的登录方式；取消后可以重新登录', async () => {
    const { subject, files } = loginSetup({ CODEBUDDY_INTERNET_ENVIRONMENT: 'External' });
    await subject.read('workbuddy');
    const first = await subject.login('workbuddy', 'browser');
    const cancelled = await subject.cancelLogin('workbuddy', first.login?.loginId);
    expect(cancelled.status).toBe('signed_out');
    expect(cancelled.lastError).toBeUndefined();
    expect(existsSync(files.state)).toBe(false);
    // 与进行中的不符的 loginId 什么都不做
    const second = await subject.login('workbuddy', 'browser');
    expect((await subject.cancelLogin('workbuddy', 'other-id')).status).toBe('signing_in');
    const signedIn = until(subject, (state) => state.status === 'signed_in');
    writeFileSync(files.done, 'approved');
    await signedIn;
    expect(second.login?.loginId).not.toBe(first.login?.loginId);
    expect(authCalls(files.auth).map((call) => call.methodId)).toEqual(['external', 'external']);
  });

  it('登录方式由调用方选：没设环境变量时 option 决定 methodId，不认识的 option 不起进程', async () => {
    const { subject, files } = loginSetup();
    await subject.read('workbuddy');
    await expect(subject.login('workbuddy', 'browser', { option: 'iOA' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(existsSync(files.auth)).toBe(false);
    const started = await subject.login('workbuddy', 'browser', { option: 'external' });
    expect(started.status).toBe('signing_in');
    const signedIn = until(subject, (state) => state.status === 'signed_in');
    writeFileSync(files.done, 'approved');
    await signedIn;
    expect(authCalls(files.auth).map((call) => call.methodId)).toEqual(['external']);
  });

  it('继承的环境变量已经定了哪个站：选相反的 option 被拒绝', async () => {
    const { subject, files } = loginSetup({ CODEBUDDY_INTERNET_ENVIRONMENT: 'internal' });
    await subject.read('workbuddy');
    await expect(
      subject.login('workbuddy', 'browser', { option: 'external' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(existsSync(files.auth)).toBe(false);
    // 选对应的，或不选，都可以。
    const started = await subject.login('workbuddy', 'browser', { option: 'internal' });
    expect(started.status).toBe('signing_in');
    await subject.cancelLogin('workbuddy');
  });

  it('授权失败：回到未登录，原因在 lastError；下一次读取（refresh）清掉它', async () => {
    const { subject } = loginSetup({ FAKE_WORKBUDDY_AUTH_FAIL: '1' });
    await subject.read('workbuddy');
    const failed = until(
      subject,
      (state) => state.status === 'signed_out' && state.lastError !== undefined,
    );
    await subject.login('workbuddy', 'browser');
    expect(await failed).toMatchObject({
      status: 'signed_out',
      lastError: expect.stringContaining('Authentication required'),
    });
    expect((await subject.read('workbuddy', { refresh: true })).lastError).toBeUndefined();
  });

  it('CodeBuddy 没有给出登录地址：报错并停掉进程，带上终端里的办法', async () => {
    const variants: Array<Record<string, string>> = [
      { FAKE_WORKBUDDY_AUTH_NO_URL: '1', FAKE_WORKBUDDY_AUTH_FAIL: '1' },
      { FAKE_WORKBUDDY_AUTH_NO_URL: '1' },
    ];
    for (const extra of variants) {
      const { subject } = loginSetup(extra, 300);
      await subject.read('workbuddy');
      await expect(subject.login('workbuddy', 'browser')).rejects.toMatchObject({
        code: 'engine_unavailable',
        message: expect.stringContaining('run codebuddy in a terminal'),
      });
      expect((await subject.read('workbuddy')).status).toBe('signed_out');
    }
  });

  it('没装 CodeBuddy 时不能登录；非 browser 方式不支持', async () => {
    const subject = new WorkBuddyAccounts({
      workDir: temp.dir('login-missing'),
      env: fakeWorkBuddyEnv(),
      installer: null,
      findExecutable: () => {
        throw new Error('missing');
      },
    });
    subjects.push(subject);
    await expect(subject.login('workbuddy', 'browser')).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
    await expect(subject.login('workbuddy', 'device_code')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe.skipIf(process.platform === 'win32')('下载安装', () => {
  const archive = Buffer.from('archive');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const ARCHIVE = {
    name: 'codebuddy-code_Test.tar.gz',
    format: 'tar.gz',
    fileName: 'codebuddy',
  } as const;
  const release = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/latest')) return new Response('9.9.9\n');
    if (url.endsWith('/checksums.txt')) return new Response(`${checksum}  ${ARCHIVE.name}\n`);
    return new Response(archive, { headers: { 'content-length': String(archive.length) } });
  };

  function installSetup(env: Record<string, string> = {}, fetchImpl: typeof fetch = release) {
    const dir = temp.dir(`install-${++seq}`);
    const envLog = join(dir, 'env.ndjson');
    const processEnv = fakeWorkBuddyEnv({ FAKE_WORKBUDDY_ENV_LOG: envLog, ...env });
    // 用户自己没装：只有 Wevir 下载的那份。
    delete processEnv.WEVIR_WORKBUDDY_BIN;
    const installer = new WorkBuddyInstaller({
      directory: join(dir, 'runtime'),
      archive: ARCHIVE,
      releaseUrl: 'https://release.invalid',
      fetch: fetchImpl,
      // 解包换成放一份假 codebuddy，和真实的压缩包一样把程序放在根目录。
      extract: async (_archive, destination) => {
        mkdirSync(destination, { recursive: true });
        copyFileSync(FAKE_WORKBUDDY, join(destination, 'codebuddy'));
        copyFileSync(join(dirname(FAKE_WORKBUDDY), 'acp.ndjson'), join(destination, 'acp.ndjson'));
        chmodSync(join(destination, 'codebuddy'), 0o755);
      },
      validate: async () => {},
    });
    const subject = new WorkBuddyAccounts({
      workDir: dir,
      env: processEnv,
      installer,
      findExecutable: (_custom, managed) => {
        if (managed === undefined) throw new Error('missing');
        return managed;
      },
    });
    subjects.push(subject);
    return { subject, dir, envLog };
  }

  it('没装时可以下载；装好后检测为已登录，Wevir 装的 codebuddy 不自更新', async () => {
    const { subject, dir, envLog } = installSetup();
    expect(await subject.read('workbuddy')).toMatchObject({
      installed: false,
      canInstall: true,
      installCommand: 'npm install -g @tencent-ai/codebuddy-code',
    });
    const progress: AccountState[] = [];
    subject.onChange((state) => progress.push(state));
    const ready = until(
      subject,
      (state) => state.installed === true && state.status === 'signed_in',
    );
    const started = await subject.install('workbuddy');
    expect(started.installing).toEqual({ completedBytes: 0 });
    const final = await ready;
    expect(progress.some((state) => state.installing !== undefined)).toBe(true);
    expect(final.installing).toBeUndefined();
    expect(final.executablePath).toBe(join(dir, 'runtime', 'versions', '9.9.9', 'codebuddy'));
    expect(final.signIn).toBe('in_app');
    const lines = readFileSync(envLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.autoupdate).toBe('1');
  });

  it('命令登录的环境里，Wevir 装的 codebuddy 写全路径', async () => {
    const { subject, dir } = installSetup({ CODEBUDDY_INTERNET_ENVIRONMENT: 'iOA' });
    const ready = until(subject, (state) => state.installed === true);
    await subject.read('workbuddy');
    await subject.install('workbuddy');
    expect((await ready).loginCommand).toBe(
      `"${join(dir, 'runtime', 'versions', '9.9.9', 'codebuddy')}"`,
    );
  });

  it('下载失败：原因在 lastError，还能再装', async () => {
    let fail = true;
    const { subject } = installSetup({}, (async (input: string | URL | Request) => {
      if (fail) throw new TypeError('fetch failed');
      return release(input);
    }) as typeof fetch);
    await subject.read('workbuddy');
    const failed = until(
      subject,
      (state) => state.installing === undefined && state.lastError !== undefined,
    );
    await subject.install('workbuddy');
    expect(await failed).toMatchObject({
      installed: false,
      canInstall: true,
      lastError: expect.stringContaining('Could not reach the CodeBuddy download'),
    });
    fail = false;
    const ready = until(subject, (state) => state.installed === true);
    await subject.install('workbuddy');
    expect((await ready).lastError).toBeUndefined();
  });

  it('Wevir 装的那份跑不起来：当作没装，可以重新下载', async () => {
    const { subject, dir } = installSetup();
    const broken = join(dir, 'runtime', 'versions', '1.0.0');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'codebuddy'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    writeFileSync(join(dir, 'runtime', 'active.json'), JSON.stringify({ version: '1.0.0' }));
    expect(await subject.read('workbuddy')).toMatchObject({
      installed: false,
      canInstall: true,
      lastError: expect.stringContaining('did not start'),
    });
  });

  it('本平台没有官方发布时不能装', async () => {
    const subject = new WorkBuddyAccounts({
      workDir: temp.dir('install-none'),
      env: fakeWorkBuddyEnv(),
      installer: null,
    });
    subjects.push(subject);
    await expect(subject.install('workbuddy')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
