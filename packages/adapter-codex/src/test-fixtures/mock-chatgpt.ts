// 假的 OpenAI 登录服务与 ChatGPT 后端（R6）：让真实 codex-app-server 的 ChatGPT 进程走完登录、读账号、用量、模型列表与
// 登出，不需要真实账号。端点照 R6 在真实二进制上录到的（codex-event-mapping.md §8.3）：
//
// - 登录服务（`CODEX_APP_SERVER_LOGIN_ISSUER`）：`POST /api/accounts/deviceauth/usercode`、`.../deviceauth/token`
//   （放行之前回 403，Codex 照 interval 轮询），`POST /oauth/token`（授权码换令牌，也是刷新的地址），`POST /oauth/revoke`。
//   浏览器登录的 `authUrl` 指向这里的 `/oauth/authorize`，回调由测试直接打到 Codex 在 127.0.0.1:1455 的监听上。
// - 后端（`chatgpt_base_url` = `<url>/backend-api/`）：`GET /backend-api/wham/accounts/check`（工作区路由，只接受
//   https 的源，所以报 `https://chatgpt.com`）、`/wham/usage`、`/codex/models`。
//
// 令牌是不签名的 JWT（Codex 只解码载荷，不验签）。只用 Node 内置模块。

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChatgptEndpoints } from '../config.js';

export const MOCK_CHATGPT_EMAIL = 'tester@example.com';
export const MOCK_CHATGPT_PLAN = 'plus';
export const MOCK_CHATGPT_MODEL = 'mock-gpt';
export const MOCK_USER_CODE = 'ABCD-EFGH';

export interface MockChatgptRequest {
  method: string;
  path: string;
  userAgent?: string;
  originator?: string;
  body: string;
}

export interface MockChatgpt {
  readonly url: string;
  readonly endpoints: ChatgptEndpoints;
  readonly requests: MockChatgptRequest[];
  /** 设备码登录：放行，下一次轮询返回授权码（只管一次登录）。 */
  approveDeviceCode(): void;
  /**
   * 浏览器登录：替用户完成授权，把 code 与 state 回调给 authUrl 里的 redirect_uri（Codex 在本机监听），并跟着重定向加载成功页。
   * 返回最后的 HTTP 状态码。
   */
  completeBrowserLogin(authUrl: string): Promise<number>;
  close(): Promise<void>;
}

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.sig`;
}

function modelInfo(slug: string, isDefault: boolean): Record<string, unknown> {
  return {
    slug,
    display_name: slug === MOCK_CHATGPT_MODEL ? 'Mock GPT' : slug,
    description: 'mock',
    base_instructions: 'You are a mock model.',
    supported_reasoning_levels: [
      { effort: 'low', description: 'low' },
      { effort: 'high', description: 'high' },
      { effort: 'ultra', description: 'ultra' },
    ],
    default_reasoning_level: 'low',
    shell_type: 'unified_exec',
    visibility: 'list',
    supported_in_api: true,
    priority: isDefault ? 1 : 2,
    availability_nux: null,
    upgrade: null,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    experimental_supported_tools: [],
    include_apps_usage_instructions: false,
    input_modalities: ['text', 'image'],
    context_window: 200_000,
  };
}

export async function startMockChatgpt(): Promise<MockChatgpt> {
  const requests: MockChatgptRequest[] = [];
  let approved = false;
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const auth = {
    chatgpt_plan_type: MOCK_CHATGPT_PLAN,
    chatgpt_user_id: 'user-mock',
    chatgpt_account_id: 'acc-mock',
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      requests.push({
        method: req.method ?? '',
        path,
        ...(typeof req.headers['user-agent'] === 'string' && {
          userAgent: req.headers['user-agent'],
        }),
        ...(typeof req.headers.originator === 'string' && { originator: req.headers.originator }),
        body,
      });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      switch (path) {
        case '/api/accounts/deviceauth/usercode':
          return send(200, { device_auth_id: 'dev-1', user_code: MOCK_USER_CODE, interval: '1' });
        case '/api/accounts/deviceauth/token':
          if (!approved) return send(403, { error: 'authorization_pending' });
          // 放行只管一次登录：下一次设备码登录又要等放行。
          approved = false;
          return send(200, {
            authorization_code: 'code-1',
            code_challenge: 'ch',
            code_verifier: 've',
          });
        case '/oauth/token':
          // 浏览器登录换完令牌之后还会用 token-exchange 换一个 API Key（login/src/server.rs `obtain_api_key`）。
          if (body.includes('grant-type%3Atoken-exchange')) {
            return send(200, { access_token: 'mock-api-key-not-a-secret' });
          }
          return send(200, {
            id_token: jwt({ email: MOCK_CHATGPT_EMAIL, exp, 'https://api.openai.com/auth': auth }),
            access_token: jwt({ exp, 'https://api.openai.com/auth': auth }),
            refresh_token: 'refresh-mock',
          });
        case '/oauth/revoke':
          return send(200, {});
        case '/oauth/authorize':
          return send(200, { note: 'mock authorize page' });
        case '/backend-api/wham/accounts/check':
          return send(200, {
            accounts: [
              {
                id: req.headers['chatgpt-account-id'] ?? 'acc-mock',
                workspace_backend_origin: 'https://chatgpt.com',
                account_routing_override: 'NO_CONSTRAINT',
              },
            ],
          });
        case '/backend-api/wham/usage': {
          const now = Math.floor(Date.now() / 1000);
          return send(200, {
            plan_type: MOCK_CHATGPT_PLAN,
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 23,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3600,
                reset_at: now + 3600,
              },
              secondary_window: {
                used_percent: 40,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400,
                reset_at: now + 86_400,
              },
            },
          });
        }
        case '/backend-api/codex/models':
          return send(200, {
            models: [modelInfo(MOCK_CHATGPT_MODEL, true), modelInfo('mock-gpt-mini', false)],
          });
        default:
          return send(404, { error: 'not mocked' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    endpoints: { issuer: url, backend: url },
    requests,
    approveDeviceCode: () => {
      approved = true;
    },
    async completeBrowserLogin(authUrl: string): Promise<number> {
      const params = new URL(authUrl).searchParams;
      const redirect = params.get('redirect_uri');
      const state = params.get('state');
      if (redirect === null || state === null)
        throw new Error(`authUrl 缺 redirect_uri 或 state：${authUrl}`);
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'code-browser');
      callback.searchParams.set('state', state);
      // 跟着重定向走：Codex 的回调换完令牌后把浏览器带到本机的 /success，加载了它登录才算完成。有时限：取消登录后
      // 回调端口正在关的那一刻连上的请求可能一直没有回应（Windows CI 上见过），按失败算。
      const response = await fetch(callback, { signal: AbortSignal.timeout(15_000) });
      await response.arrayBuffer().catch(() => {});
      return response.status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
