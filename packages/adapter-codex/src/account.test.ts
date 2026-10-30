import type { AccountState } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { type AccountRpc, accountModels, ChatgptAccount } from './account.js';
import type { GetAccountResponse } from './protocol.js';

// ChatgptAccount 对着假的 app-server：请求的结果按方法给出，形状照 R6 在真实二进制上录到的（codex-event-mapping.md §8）。

type Handler = (params: unknown) => unknown;

function fakeRpc(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc: AccountRpc = {
    async request<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`没有 ${method}`);
      return handler(params) as T;
    },
  };
  return { rpc, calls };
}

const signedOut = (): GetAccountResponse => ({ account: null, requiresOpenaiAuth: true });
const signedIn = (): GetAccountResponse => ({
  account: { type: 'chatgpt', email: 'me@example.com', planType: 'plus' },
  requiresOpenaiAuth: true,
});
const usage = () => ({
  rateLimits: {
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_791_957_611 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
    planType: 'plus',
  },
});

function setup(handlers: Record<string, Handler>) {
  const { rpc, calls } = fakeRpc(handlers);
  const warnings: string[] = [];
  const account = new ChatgptAccount({
    rpc: async () => rpc,
    warn: (message) => warnings.push(message),
    now: () => new Date('2026-10-14T08:00:00.000Z'),
  });
  const states: AccountState[] = [];
  account.onChange((state) => states.push(state));
  return { account, calls, states, warnings };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChatgptAccount', () => {
  it('读账号：没登录；登录了带邮箱、套餐与用量（Unix 秒换成 ISO 时间）', async () => {
    let read = signedOut;
    const { account, calls } = setup({
      'account/read': () => read(),
      'account/rateLimits/read': usage,
    });
    expect(await account.read()).toEqual({ kind: 'chatgpt', status: 'signed_out' });
    expect(calls.map((c) => c.method)).toEqual(['account/read']);
    read = signedIn;
    expect(await account.read()).toEqual({
      kind: 'chatgpt',
      status: 'signed_in',
      email: 'me@example.com',
      plan: 'plus',
      rateLimits: {
        primary: { usedPercent: 23, windowMinutes: 300, resetsAt: '2026-10-14T06:00:11.000Z' },
        secondary: { usedPercent: 40, windowMinutes: 10080 },
      },
    });
  });

  it('用量读不到时照样报已登录', async () => {
    const { account } = setup({
      'account/read': signedIn,
      'account/rateLimits/read': () => {
        throw new Error('codex account authentication required to read rate limits');
      },
    });
    const state = await account.read();
    expect(state.status).toBe('signed_in');
    expect(state.rateLimits).toBeUndefined();
  });

  it('设备码登录：登录中带网址与码；成功的通知之后重读账号', async () => {
    let read = signedOut;
    const { account, states } = setup({
      'account/read': () => read(),
      'account/rateLimits/read': usage,
      'account/login/start': (params) => {
        expect(params).toEqual({ type: 'chatgptDeviceCode' });
        return {
          type: 'chatgptDeviceCode',
          loginId: 'login-1',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH',
        };
      },
    });
    await account.read();
    const started = await account.login('device_code');
    expect(started).toEqual({
      kind: 'chatgpt',
      status: 'signing_in',
      login: {
        loginId: 'login-1',
        method: 'device_code',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        startedAt: '2026-10-14T08:00:00.000Z',
      },
    });
    read = signedIn;
    account.onNotification('account/login/completed', {
      loginId: 'login-1',
      success: true,
      error: null,
    });
    account.onNotification('account/updated', { authMode: 'chatgpt', planType: 'plus' });
    await settle();
    await settle();
    expect(account.state).toMatchObject({
      status: 'signed_in',
      email: 'me@example.com',
      plan: 'plus',
    });
    // 读到未登录 → 登录中 → 登录成功（还没有邮箱）→ account/updated 带上套餐 → 重读后带上邮箱与用量；没变化的不重复通知。
    expect(states.map((s) => s.status)).toEqual([
      'signed_out',
      'signing_in',
      'signed_in',
      'signed_in',
      'signed_in',
    ]);
    expect(states.at(-1)?.email).toBe('me@example.com');
  });

  it('浏览器登录：给出 authUrl；失败的通知记下原文', async () => {
    const { account } = setup({
      'account/read': signedOut,
      'account/login/start': () => ({
        type: 'chatgpt',
        loginId: 'login-2',
        authUrl: 'https://auth.openai.com/oauth/authorize?x=1',
      }),
    });
    const started = await account.login('browser');
    expect(started.login).toMatchObject({
      method: 'browser',
      authUrl: 'https://auth.openai.com/oauth/authorize?x=1',
    });
    account.onNotification('account/login/completed', {
      loginId: 'login-2',
      success: false,
      error: 'Login timed out',
    });
    expect(account.state).toEqual({
      kind: 'chatgpt',
      status: 'signed_out',
      lastError: 'Login timed out',
    });
  });

  it('取消：随即回到原来的状态，app-server 随后的“没有完成”不记错误；loginId 对不上时什么都不做', async () => {
    const { account, calls } = setup({
      'account/read': signedOut,
      'account/login/start': () => ({
        type: 'chatgpt',
        loginId: 'login-3',
        authUrl: 'https://auth.openai.com/a',
      }),
      'account/login/cancel': () => ({ status: 'canceled' }),
    });
    await account.login('browser');
    expect((await account.cancelLogin('other')).status).toBe('signing_in');
    expect(await account.cancelLogin('login-3')).toEqual({ kind: 'chatgpt', status: 'signed_out' });
    expect(calls.at(-1)).toEqual({
      method: 'account/login/cancel',
      params: { loginId: 'login-3' },
    });
    account.onNotification('account/login/completed', {
      loginId: 'login-3',
      success: false,
      error: 'Login server error: Login was not completed',
    });
    expect(account.state).toEqual({ kind: 'chatgpt', status: 'signed_out' });
  });

  it('新的登录替换旧的：旧登录的失败通知不记错误、不影响新的', async () => {
    let next = 0;
    const { account } = setup({
      'account/read': signedOut,
      'account/login/start': () => {
        next += 1;
        return { type: 'chatgpt', loginId: `login-${next}`, authUrl: 'https://auth.openai.com/a' };
      },
    });
    await account.login('browser');
    await account.login('device_code');
    account.onNotification('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'Login was not completed',
    });
    expect(account.state).toMatchObject({ status: 'signing_in', login: { loginId: 'login-2' } });
  });

  it('登出；account/updated 的 authMode 为 null 时回到未登录', async () => {
    const { account, calls } = setup({
      'account/read': signedIn,
      'account/rateLimits/read': usage,
      'account/logout': () => ({}),
    });
    await account.read();
    expect(await account.logout()).toEqual({ kind: 'chatgpt', status: 'signed_out' });
    expect(calls.at(-1)?.method).toBe('account/logout');
    await account.read();
    account.onNotification('account/updated', { authMode: null, planType: null });
    expect(account.state.status).toBe('signed_out');
  });

  it('用量的稀疏更新合进已有的用量', async () => {
    const { account } = setup({ 'account/read': signedIn, 'account/rateLimits/read': usage });
    await account.read();
    account.onNotification('account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: null } },
    });
    expect(account.state.rateLimits).toEqual({
      primary: { usedPercent: 50, windowMinutes: 300 },
      secondary: { usedPercent: 40, windowMinutes: 10080 },
    });
  });

  it('模型单独的额度（rateLimitsByLimitId）另成窗口，额度名在 scope；稀疏更新按 limitId 合进对应的额度', async () => {
    const byLimit = () => ({
      ...usage(),
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', ...usage().rateLimits },
        codex_bengalfox: {
          limitId: 'codex_bengalfox',
          limitName: 'GPT-5.3-Codex-Spark',
          primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          planType: 'plus',
        },
      },
    });
    const { account } = setup({ 'account/read': signedIn, 'account/rateLimits/read': byLimit });
    await account.read();
    const main = {
      primary: { usedPercent: 23, windowMinutes: 300, resetsAt: '2026-10-14T06:00:11.000Z' },
      secondary: { usedPercent: 40, windowMinutes: 10080 },
    };
    expect(account.state.rateLimits).toEqual({
      ...main,
      windows: [
        main.primary,
        main.secondary,
        { usedPercent: 5, windowMinutes: 300, scope: 'GPT-5.3-Codex-Spark' },
      ],
    });
    // Spark 的更新不覆盖主额度。
    account.onNotification('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex_bengalfox',
        primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: null },
      },
    });
    expect(account.state.rateLimits?.primary).toEqual(main.primary);
    expect(account.state.rateLimits?.windows?.[2]).toEqual({
      usedPercent: 70,
      windowMinutes: 300,
      scope: 'GPT-5.3-Codex-Spark',
    });
  });

  it('refreshUsage 只重读用量；没登录时不发请求', async () => {
    let percent = 23;
    const { account, calls, states } = setup({
      'account/read': signedIn,
      'account/rateLimits/read': () => ({
        rateLimits: {
          primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          planType: 'plus',
        },
      }),
    });
    await account.refreshUsage();
    expect(calls).toEqual([]);
    await account.read();
    percent = 60;
    await account.refreshUsage();
    expect(calls.map((call) => call.method)).toEqual([
      'account/read',
      'account/rateLimits/read',
      'account/rateLimits/read',
    ]);
    expect(states.at(-1)?.rateLimits).toEqual({ primary: { usedPercent: 60, windowMinutes: 300 } });
  });

  it('与上一条通知相同的窗口是缓存的旧额度，不覆盖重读到的新用量', async () => {
    let percent = 100;
    const { account } = setup({
      'account/read': signedIn,
      'account/rateLimits/read': () => ({
        rateLimits: {
          primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: null },
          secondary: null,
          planType: 'plus',
        },
      }),
    });
    await account.read();
    const stale = {
      rateLimits: {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: null },
      },
    };
    account.onNotification('account/rateLimits/updated', stale);
    // 额度重置后重读到 0%；随后的 token 用量又带来同样的缓存额度。
    percent = 0;
    await account.refreshUsage();
    account.onNotification('account/rateLimits/updated', stale);
    expect(account.state.rateLimits?.primary).toEqual({ usedPercent: 0, windowMinutes: 300 });
    // 变了的窗口照常更新，没变的那个仍不动。
    account.onNotification('account/rateLimits/updated', {
      rateLimits: {
        ...stale.rateLimits,
        secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: null },
      },
    });
    expect(account.state.rateLimits).toEqual({
      primary: { usedPercent: 0, windowMinutes: 300 },
      secondary: { usedPercent: 41, windowMinutes: 10080 },
    });
    // 新进程的第一条通知照常生效。
    account.onExit();
    account.onNotification('account/rateLimits/updated', stale);
    expect(account.state.rateLimits?.primary).toEqual({ usedPercent: 100, windowMinutes: 300 });
  });

  it('进程退出时登录中断，记一条错误', async () => {
    const { account } = setup({
      'account/read': signedOut,
      'account/login/start': () => ({ type: 'chatgpt', loginId: 'l', authUrl: 'https://a.b/c' }),
    });
    await account.login('browser');
    account.onExit();
    expect(account.state).toEqual({
      kind: 'chatgpt',
      status: 'signed_out',
      lastError: 'codex-app-server 退出了，登录没有完成',
    });
  });

  it('assertSignedIn：没登录报 missing_credentials（ChatGPT 会话不发未登录的请求）', async () => {
    let read = signedOut;
    const { account } = setup({ 'account/read': () => read(), 'account/rateLimits/read': usage });
    await expect(account.assertSignedIn()).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'missing_credentials',
    });
    read = signedIn;
    await account.read();
    await expect(account.assertSignedIn()).resolves.toBeUndefined();
  });

  it('读账号失败：读过就用上次的状态，没读过报 engine_unavailable', async () => {
    let fail = true;
    const { account, warnings } = setup({
      'account/read': () => {
        if (fail) throw new Error('workspace routing discovery failed');
        return signedOut();
      },
    });
    await expect(account.read()).rejects.toMatchObject({ code: 'engine_unavailable' });
    fail = false;
    await account.read();
    fail = true;
    expect((await account.read()).status).toBe('signed_out');
    expect(warnings).toHaveLength(1);
  });
});

describe('accountModels（model/list → Wevir 的模型）', () => {
  it('取 model 作为 ID、显示名、图片输入、Wevir 认得的推理档位；默认模型取 isDefault', () => {
    const effort = (reasoningEffort: string) => ({ reasoningEffort, description: '' });
    expect(
      accountModels([
        {
          id: 'gpt-6-astra',
          model: 'gpt-6-astra',
          displayName: 'GPT-6-Astra',
          hidden: false,
          supportedReasoningEfforts: [effort('low'), effort('high')],
          defaultReasoningEffort: 'low',
          inputModalities: ['text'],
          isDefault: false,
        },
        {
          id: 'gpt-6.1-sol',
          model: 'gpt-6.1-sol',
          displayName: 'GPT-6.1-Sol',
          hidden: false,
          supportedReasoningEfforts: [effort('none'), effort('xhigh'), effort('ultra')],
          defaultReasoningEffort: 'low',
          inputModalities: ['text', 'image'],
          isDefault: true,
        },
        {
          id: 'hidden',
          model: 'hidden',
          displayName: 'Hidden',
          hidden: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'low',
          inputModalities: ['text'],
          isDefault: false,
        },
      ]),
    ).toEqual({
      models: [
        { id: 'gpt-6-astra', displayName: 'GPT-6-Astra', reasoningEfforts: ['low', 'high'] },
        {
          id: 'gpt-6.1-sol',
          displayName: 'GPT-6.1-Sol',
          supportsImages: true,
          reasoningEfforts: ['off', 'xhigh'],
        },
      ],
      defaultModelId: 'gpt-6.1-sol',
    });
  });

  it('没有标默认的取第一个；空列表没有默认', () => {
    expect(accountModels([])).toEqual({ models: [] });
  });
});
