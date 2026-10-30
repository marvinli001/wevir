import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_TOOLS_SERVER, type AppToolsEndpoint } from './types.js';

// 应用级工具的 stdio 桥（0.30.0，domain-model §3.15）：ACP 的引擎（Grok、Antigravity、WorkBuddy、dsh）都会接 stdio 的 MCP 服务，HTTP 的不一定
// 接得上（T3 Code 的 AcpMcpStdioBridge 也是因此用桥），所以给它们一个 stdio 服务，把每条 JSON-RPC 原样转发给 Host 的 `/mcp`。
// 地址与这个会话的令牌经这个服务自己的环境变量给（ACP `McpServer` 的 `env`），不进引擎进程的环境。脚本只用 Node 内置模块，由
// 适配器在引擎第一次启动前写进数据目录，用 Host 自己的 Node 运行（Electron 里带 `ELECTRON_RUN_AS_NODE=1`），同读历史的工具。

export const APP_TOOLS_URL_ENV = 'WEVIR_APP_TOOLS_URL';
export const APP_TOOLS_TOKEN_ENV = 'WEVIR_APP_TOOLS_TOKEN';

/**
 * 桥的源码：stdin 一行一条 JSON-RPC，逐条 POST 给 Host，回复按到达顺序写回 stdout（请求可以并发）。引擎发来
 * `notifications/cancelled` 时中止它点名的那个请求（通知照样转给 Host），stdin 关闭（引擎退出或不再用这个服务）时中止全部，
 * 被中止的请求不再回复（T3 Code #23955）。
 */
export const APP_TOOLS_BRIDGE_SCRIPT = `// 由 Wevir 生成（packages/runtime-adapter/src/app-tools-bridge.ts），每次启动引擎前重写，不要手改。
import { createInterface } from 'node:readline';

const URL_ = process.env.${APP_TOOLS_URL_ENV};
const TOKEN = process.env.${APP_TOOLS_TOKEN_ENV};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
/** 进行中的请求的中止开关，按 JSON-RPC 的 id。 */
const inflight = new Map();
const key = (id) => JSON.stringify(id);

async function forward(message) {
  const isRequest = message && typeof message.method === 'string' && message.id !== undefined && message.id !== null;
  const abort = new AbortController();
  if (isRequest) inflight.set(key(message.id), abort);
  try {
    const response = await fetch(URL_, {
      signal: abort.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer ' + TOKEN,
      },
      body: JSON.stringify(message),
    });
    const text = await response.text();
    if (!isRequest || abort.signal.aborted) return;
    if (!response.ok || text === '') {
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Wevir app tools: HTTP ' + response.status } });
    }
    send(JSON.parse(text));
  } catch (error) {
    if (isRequest && !abort.signal.aborted) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Wevir app tools unavailable: ' + (error && error.message) } });
    }
  } finally {
    if (isRequest && inflight.get(key(message.id)) === abort) inflight.delete(key(message.id));
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('close', () => {
  for (const abort of inflight.values()) abort.abort();
  inflight.clear();
});
lines.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  if (message && message.method === 'notifications/cancelled' && message.params && message.params.requestId !== undefined) {
    inflight.get(key(message.params.requestId))?.abort();
  }
  void forward(message);
});
`;

/** 怎样运行这个桥：脚本与运行它的 Node。 */
export interface AppToolsBridge {
  script: string;
  /** 默认 `process.execPath`（Host 自己的 Node；Electron 里是 Electron，靠 `ELECTRON_RUN_AS_NODE`）。 */
  node: string;
}

/** 桥的位置（脚本在 `<dir>/wevir-app-tools.mjs`）。只算路径、不写文件。 */
export function appToolsBridge(dir: string, node = process.execPath): AppToolsBridge {
  return { script: join(dir, 'wevir-app-tools.mjs'), node };
}

/** 写脚本（0600，覆盖）。引擎启动前调用，可重复。 */
export function writeAppToolsBridgeScript(bridge: AppToolsBridge): void {
  mkdirSync(dirname(bridge.script), { recursive: true, mode: 0o700 });
  writeFileSync(bridge.script, APP_TOOLS_BRIDGE_SCRIPT, { mode: 0o600 });
  chmodSync(bridge.script, 0o600);
}

/** ACP `session/new` / `session/resume` 的 `mcpServers` 里的一项（stdio）：这个会话的桥。 */
export function acpAppToolsServer(
  bridge: AppToolsBridge,
  endpoint: AppToolsEndpoint,
): { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> } {
  return {
    name: APP_TOOLS_SERVER,
    command: bridge.node,
    args: [bridge.script],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: APP_TOOLS_URL_ENV, value: endpoint.url },
      { name: APP_TOOLS_TOKEN_ENV, value: endpoint.token },
    ],
  };
}
