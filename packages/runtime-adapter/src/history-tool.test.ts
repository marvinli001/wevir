import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HISTORY_TOOL_NAME,
  historyFilePath,
  historyToolCommand,
  historyToolServer,
  writeHistoryFile,
  writeHistoryToolScript,
} from './history-tool.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 起一个读历史的 MCP 服务，按行收发 JSON-RPC。 */
function startServer() {
  const root = mkdtempSync(join(tmpdir(), 'wevir-history-'));
  dirs.push(root);
  const historyDir = join(root, 'history');
  const server = historyToolServer(join(root, 'mcp'), historyDir);
  writeHistoryToolScript(server);
  const { command, args, env } = historyToolCommand(server);
  // 不继承 Vitest worker 的 execArgv（AGENTS.md）。
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'pipe' });
  const replies = new Map<number, (value: unknown) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id: number };
    replies.get(message.id)?.(message);
  });
  let nextId = 1;
  // biome-ignore lint/suspicious/noExplicitAny: 测试只读回复的字段。
  const call = (method: string, params: unknown = {}): Promise<any> => {
    const id = nextId++;
    const reply = new Promise((resolve) => replies.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  };
  const tool = async (args: Record<string, unknown>) => {
    const reply = await call('tools/call', { name: HISTORY_TOOL_NAME, arguments: args });
    const text = reply.result.content[0].text as string;
    return { isError: reply.result.isError === true, text, json: () => JSON.parse(text) };
  };
  return { root, historyDir, server, child, call, tool };
}

describe('读历史的 MCP 服务', () => {
  it('initialize、tools/list，按页读，读一条长的，会话 ID 不对或没有历史时报错', async () => {
    const env = startServer();
    try {
      const init = await env.call('initialize', { protocolVersion: '2025-06-18' });
      expect(init.result.serverInfo.name).toBe('wevir_history');
      const list = await env.call('tools/list');
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        HISTORY_TOOL_NAME,
      ]);

      expect((await env.tool({ sessionId: SESSION })).isError).toBe(true);
      expect((await env.tool({ sessionId: '../etc/passwd' })).text).toContain('sessionId');

      const long = '字'.repeat(5000);
      writeHistoryFile(env.historyDir, {
        sessionId: SESSION,
        throughSeq: 40,
        writtenAt: '2026-10-15T00:00:00.000Z',
        items: Array.from({ length: 25 }, (_, index) => ({
          position: index + 1,
          itemId: `e${index + 2}`,
          seq: index + 2,
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          kind: index % 2 === 0 ? 'user_message' : 'assistant_message',
          text: index === 0 ? long : `第 ${index + 1} 条`,
        })),
      });
      if (process.platform !== 'win32') {
        expect(statSync(historyFilePath(env.historyDir, SESSION)).mode & 0o777).toBe(0o600);
      }

      const page1 = (await env.tool({ sessionId: SESSION })).json();
      expect(page1).toMatchObject({ total: 25, throughSeq: 40, nextPosition: 20 });
      expect(page1.items).toHaveLength(20);
      expect(Array.from(page1.items[0].text as string)).toHaveLength(4000);
      expect(page1.items[0].nextTextOffset).toBe(4000);
      const page2 = (await env.tool({ sessionId: SESSION, afterPosition: 20 })).json();
      expect(page2.items.map((item: { position: number }) => item.position)).toEqual([
        21, 22, 23, 24, 25,
      ]);
      expect(page2.nextPosition).toBeNull();

      const rest = (await env.tool({ sessionId: SESSION, itemId: 'e2', textOffset: 4000 })).json();
      expect(Array.from(rest.text as string)).toHaveLength(1000);
      expect(rest.nextTextOffset).toBeNull();
      expect((await env.tool({ sessionId: SESSION, itemId: 'e99' })).isError).toBe(true);
    } finally {
      env.child.kill();
    }
  });
});
