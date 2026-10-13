// 回合失败的真实样本：真实 dsh + 本地 mock Provider 按提示词里的 [case:…] 返回 HTTP 错误或断开连接，经
// DshAdapter 得到 turn.failed。断言原文与 test-fixtures/acp/errors/prompt-provider-*.json 逐字相同：dsh 升级
// 改了措辞时这里先失败，样本与归类规则（turn-error.ts）一起更新。Provider 的重试关掉（maxRetries 0），
// 否则 429、500 与连接错误要重试 5 次，约 16 s；最终的错误文本相同（T3.2 实测）。

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import { readFixture } from './test-fixtures/acp-fixtures.js';
import { MOCK_KEY, MOCK_KEY_ENV, MOCK_MODEL } from './test-fixtures/mock-model.js';
import type { TurnErrorCategory } from './turn-error.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-turn-error-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HTTP_ERRORS: Record<string, [number, unknown]> = {
  'openai-401': [
    401,
    {
      error: {
        message: 'Incorrect API key provided: sk-****',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    },
  ],
  'openai-429': [
    429,
    { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } },
  ],
  'openai-500': [500, { error: { message: 'Internal server error', type: 'api_error' } }],
  'deepseek-401': [
    401,
    {
      error: {
        message: 'Authentication Fails, Your api key: ****abcd is invalid',
        type: 'authentication_error',
        param: null,
        code: 'invalid_request_error',
      },
    },
  ],
};

/** 按请求体里的 [case:…] 返回错误；connection 直接断开连接。 */
async function startFailingModel(): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model' }] }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const name = /\[case:([a-z0-9-]+)\]/.exec(body)?.[1] ?? '';
      const reply = HTTP_ERRORS[name];
      if (reply === undefined) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply[1]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const NO_RETRY = ['retryPolicy:', '  mode: normal', '  maxRetries: 0'];
const indent = (lines: string[], spaces: number) => lines.map((l) => `${' '.repeat(spaces)}${l}`);

function overlay(route: 'openai-compatible' | 'deepseek-official', origin: string): string {
  const file = join(tempDir('overlay'), 'provider.yml');
  const lines =
    route === 'openai-compatible'
      ? [
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          '      wevir-test:',
          '        displayName: Wevir Test',
          `        apiKeyEnv: ${MOCK_KEY_ENV}`,
          '        api: openai-completions',
          `        baseURL: ${origin}/v1`,
          '        compat:',
          '          supportsDeveloperRole: false',
          '          maxTokensField: max_tokens',
          ...indent(NO_RETRY, 8),
          '        models:',
          `          - id: ${MOCK_MODEL}`,
          '- id: acp',
          '  config:',
          '    provider: wevir-test',
          `    model: ${MOCK_MODEL}`,
        ]
      : [
          // acp 默认路由就是 deepseek-official；只把 Key 的变量名与地址换成本地的。
          '- id: llm-deepseek',
          '  config:',
          `    apiKeyEnv: ${MOCK_KEY_ENV}`,
          `    baseURL: ${origin}`,
          ...indent(NO_RETRY, 4),
        ];
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

async function failTurn(adapter: DshAdapter, cwd: string, prompt: string): Promise<AgentEvent> {
  const { engineSessionId } = await adapter.createSession({
    cwd,
    providerId: 'wevir-test',
    modelId: MOCK_MODEL,
  });
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  await adapter.send(engineSessionId, { content: [{ type: 'text', text: prompt }] });
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error('订阅在回合结束前结束');
    if (isTurnTerminal(value)) return value;
  }
}

const CASES: Array<{
  route: 'openai-compatible' | 'deepseek-official';
  marker: string;
  fixture: string;
  category: TurnErrorCategory;
}> = [
  {
    route: 'openai-compatible',
    marker: 'openai-401',
    fixture: 'errors/prompt-provider-401.openai-compatible.json',
    category: 'provider',
  },
  {
    route: 'openai-compatible',
    marker: 'openai-429',
    fixture: 'errors/prompt-provider-429.openai-compatible.json',
    category: 'provider',
  },
  {
    route: 'openai-compatible',
    marker: 'openai-500',
    fixture: 'errors/prompt-provider-500.openai-compatible.json',
    category: 'provider',
  },
  {
    route: 'openai-compatible',
    marker: 'connection',
    fixture: 'errors/prompt-provider-connection.openai-compatible.json',
    category: 'provider',
  },
  {
    route: 'deepseek-official',
    marker: 'deepseek-401',
    fixture: 'errors/prompt-provider-401.deepseek-official.json',
    category: 'unknown',
  },
];

describe('真实 dsh：Provider 失败时的 -32603 原文与归类', () => {
  it.each(['openai-compatible', 'deepseek-official'] as const)(
    '%s',
    async (route) => {
      const origin = await startFailingModel();
      const adapter = new DshAdapter({
        home: tempDir('home'),
        patches: [overlay(route, origin)],
        env: { [MOCK_KEY_ENV]: MOCK_KEY },
        streamTap: false,
        logger: { warn: () => {} },
      });
      cleanups.push(() => adapter.dispose());
      const cwd = tempDir('ws');
      const cases = CASES.filter((c) => c.route === route);
      const results = await Promise.all(
        cases.map((c) => failTurn(adapter, cwd, `[case:${c.marker}] 你好`)),
      );
      cases.forEach((c, i) => {
        const { error } = readFixture<{ error: { message: string } }>(c.fixture);
        expect(results[i], c.fixture).toEqual({
          type: 'turn.failed',
          engineSessionId: expect.any(String),
          category: c.category,
          message: error.message,
          code: -32603,
        });
      });
    },
    30_000,
  );
});
