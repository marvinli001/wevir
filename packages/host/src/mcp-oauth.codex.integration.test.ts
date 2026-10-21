// 远程 MCP 服务的 OAuth（0.97.0）端到端：真实锁定的 app-server + 仓库的假模型 + 假的 OAuth 授权服务器与受保护的 MCP 服务。
// Codex 经 Host 的本机代理调用工具；登录后热更新拿到工具；访问令牌几秒就过期、被服务器作废后照常调用；Host 重启后代理令牌换新照常工作。
// 二进制不在时跳过（bash scripts/fetch-codex.sh，或 WEVIR_CODEX_BIN）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAdapter, resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, type MockRequestBody, startMockModel } from '@wevir/adapter-codex/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { browse, OAUTH_TOOL, startFakeOAuth } from './test-fixtures/oauth-mcp.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  console.warn('[mcp oauth + codex] 跳过：运行 bash scripts/fetch-codex.sh 下载锁定的 app-server');
}

function findTool(tools: MockRequestBody['tools']) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const nested = (tool.tools as Array<{ name?: string }>).find((item) =>
        item.name?.endsWith(OAUTH_TOOL),
      );
      if (nested?.name) return { name: nested.name, namespace: tool.name };
    } else if (tool.name?.endsWith(OAUTH_TOOL)) return { name: tool.name };
  }
  return undefined;
}

describe.skipIf(!binary || process.platform === 'win32')(
  'MCP OAuth + real Codex',
  { timeout: 180_000 },
  () => {
    it('经代理调用；登录后热更新；令牌过期与作废后照常调用；重启后照常工作', async () => {
      const home = join(temp(), 'home');
      const userHome = join(temp(), 'user');
      const fake = await startFakeOAuth({ tokenTtlSec: 3, rotateRefresh: true });
      cleanups.push(() => fake.close());
      const model = await startMockModel((view) => {
        if (view.lastUserText.includes('[call-oauth]') && view.toolOutputs.length === 0) {
          const tool = findTool(view.body.tools);
          if (!tool) return { text: ['MISSING-OAUTH-TOOL'] };
          return { toolCalls: [{ kind: 'function', ...tool, args: {} }] };
        }
        return { text: [view.toolOutputs.at(-1) ?? 'ok'] };
      });
      cleanups.push(() => model.close());

      const launch = async () => {
        const adapter = new CodexAdapter({
          home,
          binary,
          parentEnv: { ...process.env, HOME: userHome },
          logger: { warn: () => {}, info: () => {} },
        });
        const logs: string[] = [];
        const host = await startHost({
          home,
          pluginUserHome: userHome,
          adapter,
          engine: 'codex',
          logger: createLogger({ level: 'debug', mirror: (line) => logs.push(line) }),
        });
        const client = await TestRpcClient.connect(host.url);
        const stop = async () => {
          client.ws.terminate();
          await host.shutdown();
        };
        cleanups.push(stop);
        const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
        expect((await client.hello(info.token)).result.features.mcp_oauth).toBe(true);
        let session: { id: string } | undefined;
        let subscriptionId = '';
        const run = async (text: string) => {
          if (session === undefined) {
            ({ session } = await client.request('session.create', {
              providerId: 'mock',
              permissionMode: 'full_access',
            }));
            ({ subscriptionId } = await client.request('events.subscribe', {
              sessionId: session?.id,
              sinceSeq: 0,
            }));
          }
          const events = () => client.events(subscriptionId);
          const { turnId } = await client.request('session.send', {
            sessionId: session?.id,
            content: [{ type: 'text', text }],
          });
          await client.until(
            () =>
              events().find(
                (item) => item.type === 'turn.finished' && item.payload.turnId === turnId,
              ),
            'turn.finished',
            90_000,
          );
          return (
            events()
              .filter((item) => item.type === 'assistant.message')
              .at(-1)?.payload.text ?? ''
          );
        };
        return { adapter, host, client, stop, run, logs };
      };

      let { client, stop, run, adapter, logs } = await launch();
      await client.request('provider.upsert', {
        id: 'mock',
        kind: 'openai-compatible',
        displayName: 'Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'mock-key-not-a-secret',
      });
      const { connector } = await client.request('connector.add', {
        name: 'oauth_docs',
        config: { transport: 'http', url: fake.url },
      });
      expect(connector.oauth).toEqual({ status: 'required' });
      expect(await run('[call-oauth] before login')).toContain('MISSING-OAUTH-TOOL');

      const { authUrl } = await client.request('connector.login', { name: 'oauth_docs' });
      expect((await browse(authUrl)).status).toBe(200);
      expect(await run('[call-oauth] first')).toContain('OAUTH-TOOL-CALLED');
      // 令牌 3 秒过期：等过期后再调。
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(await run('[call-oauth] after expiry')).toContain('OAUTH-TOOL-CALLED');
      // 服务器把令牌作废（401）：代理刷新后重发。
      fake.revokeAllAccess();
      expect(await run('[call-oauth] after revoke')).toContain('OAUTH-TOOL-CALLED');
      expect(
        fake.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length,
      ).toBeGreaterThan(0);

      const list = await client.request('plugins.list', {});
      expect(list.connectors[0]).toMatchObject({
        name: 'oauth_docs',
        status: 'connected',
        oauth: { status: 'signed_in' },
      });
      const configToml = () => readFileSync(join(home, 'engines', 'codex', 'config.toml'), 'utf8');
      const tokens = () => [...fake.accessTokens.keys(), ...fake.refreshTokens];
      expect(configToml()).not.toContain(fake.url);
      for (const token of tokens()) {
        expect(configToml()).not.toContain(token);
        expect(JSON.stringify(list)).not.toContain(token);
        expect(logs.join('\n')).not.toContain(token);
        expect(adapter.process.stderrTail).not.toContain(token);
      }

      // 重启：令牌还在，代理令牌换新，Codex 拿新地址照常调用。
      await stop();
      ({ client, stop, run, adapter, logs } = await launch());
      expect(await run('[call-oauth] after restart')).toContain('OAUTH-TOOL-CALLED');
      for (const token of tokens()) expect(configToml()).not.toContain(token);

      // 退出登录：从引擎里拿掉。
      await client.request('connector.logout', { name: 'oauth_docs' });
      expect(await run('[call-oauth] after logout')).toContain('MISSING-OAUTH-TOOL');
    });
  },
);
