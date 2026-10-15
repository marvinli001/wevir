// 私有 profile、环境与登录网址（profile.ts）：照 T3 的 antigravityAuthSupport 测试挑的情形。

import { mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_AUTH_BROWSER_MARKER,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  type AntigravityProfile,
  antigravityEnvironment,
  antigravitySpawnSpec,
  antigravityStderrWatcher,
  antigravityStdoutFilter,
  parseAntigravityAuthorizationUrl,
  prepareAntigravityProfile,
} from './profile.js';
import { removeDir, tempDir } from './test-fixtures/runtime.js';

const VALID =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&state=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F';

let dir: string;
beforeEach(() => {
  dir = tempDir();
});
afterEach(() => removeDir(dir));

describe('parseAntigravityAuthorizationUrl', () => {
  it('只认 Google 的 OAuth 页、回调在本机 127.0.0.1 的高端口', () => {
    expect(parseAntigravityAuthorizationUrl(VALID)).toEqual({
      authorizationUrl: VALID,
      redirectUri: 'http://127.0.0.1:43123/',
      state: 'abc123',
    });
    for (const bad of [
      VALID.replace('accounts.google.com', 'evil.example.com'),
      VALID.replace('/o/oauth2/v2/auth', '/other'),
      VALID.replace('response_type=code', 'response_type=token'),
      VALID.replace('127.0.0.1%3A43123', 'example.com%3A43123'),
      VALID.replace('43123', '80'),
      `${VALID}&state=second`,
      `${VALID}#fragment`,
      `${VALID} trailing`,
      'not a url',
    ]) {
      expect(parseAntigravityAuthorizationUrl(bad)).toBeUndefined();
    }
  });
});

describe('antigravityEnvironment', () => {
  it('去掉会盖过 profile 登录的变量（Windows 的大小写别名也去掉），加上 profile、BROWSER 与自己的临时目录', () => {
    const profile: AntigravityProfile = {
      platform: 'darwin',
      geminiHome: '/data/engines/antigravity/profile',
      acpDirectory: '/data/engines/antigravity/profile/antigravity-acp',
      tokenPath: '/data/engines/antigravity/profile/antigravity-acp/acp_token.json',
      tempDirectory: '/data/engines/antigravity/tmp',
      browserCommand: "'/node' '-e' 'x' '--' '%s'",
    };
    const env = antigravityEnvironment(
      profile,
      {
        PATH: '/usr/bin',
        HOME: '/home/me',
        GEMINI_API_KEY: 'secret',
        google_api_key: 'secret',
        GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
        GEMINI_HOME: '/home/me/.gemini',
        BROWSER: 'firefox',
        TMPDIR: '/tmp',
      },
      '/data/engines/antigravity/tmp/run-1',
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/me',
      GEMINI_HOME: profile.geminiHome,
      AGY_ACP_FORCE_FILE_STORAGE: '1',
      BROWSER: profile.browserCommand,
      PYTHONUNBUFFERED: '1',
      ELECTRON_RUN_AS_NODE: '1',
      TMPDIR: '/data/engines/antigravity/tmp/run-1',
    });
    const spec = antigravitySpawnSpec({
      installation: {
        executablePath: '/rt/agy_acp_server.par',
        harnessPath: '/rt/localharness_external',
      },
      profile: { ...profile, platform: 'linux' },
      cwd: '/data',
      baseEnv: {},
      runtimeTempDirectory: '/t/run-2',
    });
    expect(spec.command).toBe('/rt/agy_acp_server.par');
    expect(spec.args).toEqual(['--uid=']);
    expect(spec.options.env.ANTIGRAVITY_HARNESS_PATH).toBe('/rt/localharness_external');
    expect(spec.options.env.TMPDIR).toBe('/t/run-2');
  });
});

describe.skipIf(process.platform === 'win32')('prepareAntigravityProfile', () => {
  it('核对 BROWSER 钩子、建 0700 的目录、写不含凭据的 settings.json、把用户的全局 skills 链进来', async () => {
    const userHome = path.join(dir, 'home');
    mkdirSync(path.join(userHome, '.gemini', 'config', 'skills'), { recursive: true });
    // 链接位置已有真目录：那是用户自己的内容，不动。
    const profileDirectory = path.join(dir, 'profile');
    mkdirSync(path.join(profileDirectory, 'antigravity-cli', 'skills'), { recursive: true });
    writeFileSync(path.join(profileDirectory, 'antigravity-cli', 'skills', 'mine.md'), 'x');
    const warnings: string[] = [];
    const profile = await prepareAntigravityProfile({
      profileDirectory,
      tempDirectory: path.join(dir, 'tmp'),
      baseEnv: { PATH: process.env.PATH, GEMINI_API_KEY: 'secret' },
      userHome,
      warn: (message) => warnings.push(message),
    });
    expect(profile.geminiHome).toBe(profileDirectory);
    expect(profile.browserCommand).toContain(process.execPath);
    for (const directory of [profile.geminiHome, profile.acpDirectory, profile.tempDirectory]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
    expect(
      JSON.parse(readFileSync(path.join(profile.acpDirectory, 'settings.json'), 'utf8')),
    ).toEqual({
      auth: { type: 'oauth-personal' },
    });
    expect(readlinkSync(path.join(profileDirectory, 'config', 'skills'))).toBe(
      path.join(userHome, '.gemini', 'config', 'skills'),
    );
    expect(
      readFileSync(path.join(profileDirectory, 'antigravity-cli', 'skills', 'mine.md'), 'utf8'),
    ).toBe('x');
    expect(warnings).toHaveLength(1);
  });

  it('BROWSER 钩子跑不起来时拒绝启动，避免运行体去开系统浏览器', async () => {
    await expect(
      prepareAntigravityProfile({
        profileDirectory: path.join(dir, 'p'),
        tempDirectory: path.join(dir, 't'),
        baseEnv: {},
        nodeExecutable: path.join(dir, 'no-such-node'),
      }),
    ).rejects.toThrow();
    await expect(
      prepareAntigravityProfile({
        profileDirectory: path.join(dir, 'p'),
        tempDirectory: path.join(dir, 't'),
        baseEnv: {},
        nodeExecutable: '/opt/odd:path/node',
      }),
    ).rejects.toThrow(/cannot be used to suppress/);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let text = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text;
}

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('stdout / stderr 上的登录网址', () => {
  it('stdout：去掉登录提示行（不是 JSON-RPC），网址交出去，其余按原样转发，跨块的行也认', async () => {
    const urls: string[] = [];
    const filter = antigravityStdoutFilter((url) => urls.push(url.authorizationUrl));
    const json = '{"jsonrpc":"2.0","id":1,"result":{}}\n';
    const output = await readAll(
      filter(
        streamOf([
          json.slice(0, 10),
          `${json.slice(10)}${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${VALID.slice(0, 30)}`,
          `${VALID.slice(30)}\n${json}`,
          `${ANTIGRAVITY_AUTH_STDOUT_PREFIX}https://evil.example.com/\n`,
        ]),
      ),
    );
    expect(output).toBe(`${json}${json}`);
    expect(urls).toEqual([VALID]);
  });

  it('stderr：BROWSER 钩子的标记行与 1.1.1 的原生提示都认，跨块也认，不合规的网址忽略', () => {
    const urls: string[] = [];
    const watch = antigravityStderrWatcher((url) => urls.push(url.authorizationUrl));
    const marker = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(VALID)}`;
    watch(`some log\n${marker.slice(0, 20)}`);
    watch(`${marker.slice(20)}\r\n`);
    watch(`${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${VALID}\n`);
    watch(`${ANTIGRAVITY_AUTH_BROWSER_MARKER}"https://evil.example.com/"\n`);
    expect(urls).toEqual([VALID, VALID]);
  });
});
