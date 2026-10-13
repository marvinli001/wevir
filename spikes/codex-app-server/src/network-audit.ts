// 外连审计：给 codex-app-server 配一个只记录目标主机的代理（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY），
// 再每 200 ms 用 lsof 抓一次它的 TCP 连接，分别跑“默认配置”和“加固配置”各一个回合（模型是本机 mock）。
//
// 用法：node src/network-audit.ts

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppServer } from './app-server.ts';
import { BINARY, childEnv, HARDENING, makeSandbox, writeConfig } from './codex-home.ts';
import { mockCatalog } from './harness.ts';
import { startMockResponses } from './mock-responses.ts';

async function startLoggingProxy(hosts: Set<string>) {
  const server = createServer((req, res) => {
    // 普通 HTTP 代理请求：记录后返回 502，不真的转发。
    hosts.add(`http ${new URL(req.url ?? '', 'http://x').host}`);
    res.writeHead(502).end();
  });
  server.on('connect', (req, socket) => {
    hosts.add(`connect ${req.url}`);
    // 不放行：记录目标后断开，保证审计不产生真实外连。
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

function tcpPeers(pid: number): string[] {
  try {
    const out = execFileSync(
      'lsof',
      ['-a', '-p', String(pid), '-i', 'TCP', '-n', '-P', '-F', 'n'],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .filter((l) => l.startsWith('n') && l.includes('->'))
      .map((l) => l.slice(1).split('->')[1] ?? '');
  } catch {
    return [];
  }
}

/** keep：保留的加固项（其余去掉）。 */
async function audit(label: string, keep: string[]): Promise<void> {
  const hosts = new Set<string>();
  const peers = new Set<string>();
  const proxy = await startLoggingProxy(hosts);
  const mock = await startMockResponses(() => ({ text: ['ok'] }));
  const sb = makeSandbox(`net-${label}`);
  writeConfig(sb.codexHome, {
    id: 'wevir_spike',
    name: 'Wevir spike',
    baseURL: mock.baseURL,
    envKey: 'K',
    model: 'wevir-mock',
    catalog: mockCatalog(),
  });
  {
    const file = `${sb.codexHome}/config.toml`;
    let text = readFileSync(file, 'utf8');
    for (const line of HARDENING) {
      if (!line.startsWith('[') && !keep.includes(line)) text = text.replace(`${line}\n`, '');
    }
    writeFileSync(file, text);
  }
  const env = childEnv(sb, {
    K: 'mock-key-not-a-secret',
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    ALL_PROXY: proxy.url,
    http_proxy: proxy.url,
    https_proxy: proxy.url,
    all_proxy: proxy.url,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  });
  const server = new AppServer({ binary: BINARY, codexHome: sb.codexHome, env });
  const timer = setInterval(() => {
    for (const p of tcpPeers(server.child.pid ?? 0)) peers.add(p);
  }, 200);
  try {
    await server.initialize(false);
    const t = await server.request<{ thread: { id: string } }>('thread/start', {
      cwd: sb.workspace,
    });
    const turn = await server.request<{ turn: { id: string } }>('turn/start', {
      threadId: t.thread.id,
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    });
    await server.waitTurnCompleted(t.thread.id, turn.turn.id);
    // 后台任务（插件同步、更新检查等）可能稍晚才发起，多等一会儿。
    await new Promise((r) => setTimeout(r, 8000));
  } finally {
    clearInterval(timer);
    await server.close();
    await mock.close();
    proxy.close();
    sb.dispose();
  }
  const local = (p: string) => p.startsWith('127.0.0.1:') || p.startsWith('[::1]:');
  console.log(`\n## ${label}`);
  console.log(`  经代理的目标：${hosts.size === 0 ? '（无）' : [...hosts].join(', ')}`);
  const remote = [...peers].filter((p) => !local(p) && !p.startsWith(new URL(proxy.url).host));
  console.log(
    `  lsof 看到的非本机 TCP 对端：${remote.length === 0 ? '（无）' : remote.join(', ')}`,
  );
}

const settings = HARDENING.filter((l) => !l.startsWith('['));
await audit('默认配置（只有 Provider）', []);
for (const line of settings) await audit(`只加 ${line}`, [line]);
await audit('全部加固项', settings);
