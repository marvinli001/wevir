import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountState, ProviderConfig } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CodexRuntime } from './codex-runtime.js';
import {
  codexBinaryOrSkip,
  collectingLogger,
  NO_RETRIES,
  proxyEnv,
  runTurn,
  startLoggingProxy,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_CHATGPT_EMAIL,
  MOCK_CHATGPT_MODEL,
  MOCK_CHATGPT_PLAN,
  MOCK_USER_CODE,
  type MockChatgpt,
  startMockChatgpt,
} from './test-fixtures/mock-chatgpt.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 真实 codex-app-server 的 ChatGPT 进程（R6，ADR-0005 补记 10，codex-event-mapping.md §8）：登录服务与 ChatGPT 后端是
// 本机 mock（mock-chatgpt.ts），Codex 的外连另经只记录、一律拒绝的代理。真实账号的登录与一问一答要维护者在场，不在这里。

const binary = codexBinaryOrSkip('adapter-codex ChatGPT 集成测试');
const dirs = new TempDirs();
let chatgpt: MockChatgpt;
let model: MockModel;
const runtimes: CodexRuntime[] = [];

const CHATGPT: ProviderConfig = {
  id: 'chatgpt',
  kind: 'chatgpt',
  displayName: 'ChatGPT',
  models: [],
  defaultModelId: MOCK_CHATGPT_MODEL,
};

beforeAll(async () => {
  chatgpt = await startMockChatgpt();
  model = await startMockModel();
});

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

afterAll(async () => {
  await chatgpt?.close();
  await model?.close();
  dirs.cleanup();
});

function runtime(parentEnv?: NodeJS.ProcessEnv) {
  const { home, workspace } = dirs.make('chatgpt');
  const created = new CodexRuntime({
    home,
    binary,
    logger: collectingLogger(),
    providerExtra: NO_RETRIES,
    chatgptEndpoints: chatgpt.endpoints,
    providers: [CHATGPT, mockProvider(model)],
    ...(parentEnv !== undefined && { parentEnv }),
  });
  runtimes.push(created);
  const states: AccountState[] = [];
  created.accounts.onChange((state) => states.push(state));
  return { runtime: created, home, workspace, states };
}

async function waitFor<T>(what: string, read: () => T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(binary === undefined)('ChatGPT 进程（mock 登录服务）', { timeout: 90_000 }, () => {
  it('没登录：账号是 signed_out，ChatGPT 会话建不起来（missing_credentials），不启动网关进程', async () => {
    const { runtime: codex, workspace } = runtime();
    expect(await codex.accounts.read('chatgpt')).toEqual({ kind: 'chatgpt', status: 'signed_out' });
    await expect(
      codex.createSession({ cwd: workspace, providerId: 'chatgpt', modelId: MOCK_CHATGPT_MODEL }),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'missing_credentials' });
    expect(codex.chatgpt.process.state).toBe('ready');
    expect(codex.gateway.process.state).toBe('stopped');
    expect((await codex.testProvider(CHATGPT, MOCK_CHATGPT_MODEL)).reason).toBe('auth');
  });

  it('设备码登录 → 已登录（邮箱、套餐、用量）→ 模型列表 → ChatGPT 会话 → 登出；凭据只在 ChatGPT 进程的目录', async () => {
    const proxy = await startLoggingProxy();
    try {
      const { runtime: codex, home, workspace, states } = runtime(proxyEnv(proxy.url));
      const started = await codex.accounts.login('chatgpt', 'device_code');
      expect(started).toMatchObject({
        status: 'signing_in',
        login: {
          method: 'device_code',
          verificationUrl: `${chatgpt.url}/codex/device`,
          userCode: MOCK_USER_CODE,
        },
      });
      chatgpt.approveDeviceCode();
      const signedIn = await waitFor('登录成功并读到邮箱', () =>
        states.find((state) => state.status === 'signed_in' && state.email !== undefined),
      );
      expect(signedIn).toMatchObject({ email: MOCK_CHATGPT_EMAIL, plan: MOCK_CHATGPT_PLAN });
      const read = await codex.accounts.read('chatgpt');
      expect(read.rateLimits?.primary).toMatchObject({ usedPercent: 23, windowMinutes: 300 });
      expect(read.rateLimits?.secondary).toMatchObject({ usedPercent: 40, windowMinutes: 10080 });

      // 凭据：ChatGPT 进程的 CODEX_HOME 里的 auth.json（0600），网关进程的目录里没有。
      const authFile = join(home, 'engines', 'codex-chatgpt', 'auth.json');
      expect(statSync(authFile).mode & 0o777).toBe(0o600);
      expect(existsSync(join(home, 'engines', 'codex', 'auth.json'))).toBe(false);
      const config = readFileSync(join(home, 'engines', 'codex-chatgpt', 'config.toml'), 'utf8');
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(config).not.toContain('WEVIR_GATEWAY_TOKEN');

      // 模型列表来自 ChatGPT 后端（不是 Wevir 的目录），Codex 多出来的推理档位（ultra）不列。
      expect(await codex.accounts.models('chatgpt')).toEqual({
        models: [
          {
            id: MOCK_CHATGPT_MODEL,
            displayName: 'Mock GPT',
            supportsImages: true,
            reasoningEfforts: ['low', 'high'],
          },
          {
            id: 'mock-gpt-mini',
            displayName: 'mock-gpt-mini',
            supportsImages: true,
            reasoningEfforts: ['low', 'high'],
          },
        ],
        defaultModelId: MOCK_CHATGPT_MODEL,
      });
      expect((await codex.testProvider(CHATGPT, MOCK_CHATGPT_MODEL)).ok).toBe(true);

      // ChatGPT 会话落在 ChatGPT 进程上（Codex 内置的 openai Provider）；经网关的会话照旧在网关进程上。
      const session = await codex.createSession({
        cwd: workspace,
        providerId: 'chatgpt',
        modelId: MOCK_CHATGPT_MODEL,
        reasoningEffort: 'high',
      });
      expect(session).toMatchObject({ modelId: MOCK_CHATGPT_MODEL, reasoningEffort: 'high' });
      expect(codex.chatgpt.hasSession(session.engineSessionId)).toBe(true);
      expect(codex.gateway.hasSession(session.engineSessionId)).toBe(false);
      const gatewaySession = await codex.createSession({
        cwd: workspace,
        providerId: mockProvider(model).id,
        modelId: MOCK_MODEL,
      });
      expect(codex.gateway.hasSession(gatewaySession.engineSessionId)).toBe(true);
      const events: Parameters<typeof runTurn>[3] = [];
      void (async () => {
        for await (const event of codex.subscribe(gatewaySession.engineSessionId))
          events.push(event);
      })();
      const turn = await runTurn(codex.gateway, gatewaySession.engineSessionId, '你好', events);
      expect(turn.at(-1)?.type).toBe('turn.settled');
      await codex.close(session.engineSessionId);

      // 登出：删掉凭据并吊销令牌，回到未登录；之后的 ChatGPT 会话又建不起来。
      expect(await codex.accounts.logout('chatgpt')).toEqual({
        kind: 'chatgpt',
        status: 'signed_out',
      });
      expect(existsSync(authFile)).toBe(false);
      expect(chatgpt.requests.some((request) => request.path === '/oauth/revoke')).toBe(true);
      await expect(
        codex.createSession({ cwd: workspace, providerId: 'chatgpt', modelId: MOCK_CHATGPT_MODEL }),
      ).rejects.toMatchObject({ code: 'missing_credentials' });

      // 登录后发往 ChatGPT 后端的请求都带 Wevir 的名字（originator / User-Agent，codex-notes §4.1）。
      const backend = chatgpt.requests.filter((request) =>
        request.path.startsWith('/backend-api/'),
      );
      expect(backend.length).toBeGreaterThan(0);
      for (const request of backend.filter((r) => r.path !== '/backend-api/codex/models')) {
        expect(request.userAgent, request.path).toMatch(/^wevir\//);
      }
      // 后端换成了 mock，外连只剩 Codex 建 ChatGPT 会话时预连的 chatgpt.com（工作区路由报的源，被代理拒绝）。
      for (const host of proxy.hosts) expect(host).toBe('connect chatgpt.com:443');
    } finally {
      await proxy.close();
    }
  });

  it('浏览器登录：authUrl 指向登录服务、回调在本机；完成后已登录。取消：回到未登录，回调端口随之关闭', async () => {
    const { runtime: codex, states } = runtime();
    const first = await codex.accounts.login('chatgpt', 'browser');
    const authUrl = first.login?.authUrl ?? '';
    expect(authUrl.startsWith(`${chatgpt.url}/oauth/authorize?`)).toBe(true);
    expect(new URL(authUrl).searchParams.get('originator')).toBe('wevir');
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:1455/auth/callback',
    );
    expect(await codex.accounts.cancelLogin('chatgpt', first.login?.loginId)).toEqual({
      kind: 'chatgpt',
      status: 'signed_out',
    });
    await expect(chatgpt.completeBrowserLogin(authUrl)).rejects.toThrow();

    const second = await codex.accounts.login('chatgpt', 'browser');
    expect(await chatgpt.completeBrowserLogin(second.login?.authUrl ?? '')).toBe(200);
    const signedIn = await waitFor('浏览器登录成功', () =>
      states.find((state) => state.status === 'signed_in' && state.email !== undefined),
    );
    expect(signedIn.email).toBe(MOCK_CHATGPT_EMAIL);
    // 取消的那次不记错误。
    expect(states.every((state) => state.lastError === undefined)).toBe(true);
    await codex.accounts.logout('chatgpt');
  });
});
