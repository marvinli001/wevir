import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, describe, expect, it } from 'vitest';
import { renderChatgptConfigToml, renderConfigToml } from './config.js';
import { CodexEventMapper } from './mapping.js';
import {
  SUGGEST_TASKS_MAX,
  suggestedTasksOf,
  suggestTasksToml,
  writeSuggestTasksServer,
} from './suggest-tasks.js';

// 建议的后续任务（0.16.0，codex-event-mapping.md §6.8）：本机 MCP 服务的脚本、config.toml 的登记与映射。

const dir = mkdtempSync(join(tmpdir(), 'wevir-suggest-tasks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 跑脚本，依次发请求，收齐回复。 */
async function talk(script: string, requests: unknown[]): Promise<unknown[]> {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const replies: unknown[] = [];
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    if ((request as { id?: unknown }).id === undefined) continue;
    const next = await lines.next();
    replies.push(JSON.parse(next.value as string));
  }
  child.kill();
  return replies;
}

describe('suggest_tasks 的 MCP 服务', () => {
  it('写进 CODEX_HOME（0600）；initialize、tools/list、tools/call 照 MCP 回答，通知不回', async () => {
    const server = writeSuggestTasksServer(dir);
    expect(server).toEqual({
      script: join(dir, 'wevir-suggest-tasks.mjs'),
      node: process.execPath,
    });
    if (process.platform !== 'win32') expect(statSync(server.script).mode & 0o777).toBe(0o600);
    const replies = await talk(server.script, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'suggest_tasks', arguments: { tasks: [{ title: 'a', prompt: 'b' }] } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'suggest_tasks', arguments: { tasks: [{ title: ' ', prompt: 'b' }] } },
      },
      { jsonrpc: '2.0', id: 5, method: 'resources/list' },
    ]);
    expect(replies[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'wevir_tasks' } },
    });
    expect(replies[1]).toMatchObject({
      id: 2,
      result: {
        tools: [
          {
            name: 'suggest_tasks',
            annotations: { readOnlyHint: true },
            inputSchema: { properties: { tasks: { maxItems: SUGGEST_TASKS_MAX } } },
          },
        ],
      },
    });
    expect(JSON.stringify(replies[2])).toContain('Showed 1 suggested task(s) to the user');
    expect(replies[3]).toMatchObject({ id: 4, result: { isError: true } });
    expect(replies[4]).toMatchObject({ id: 5, error: { code: -32601 } });
  });

  it('两种进程的 config.toml 都登记它：不需要批准，只开这一个工具', () => {
    const server = { script: '/h/wevir-suggest-tasks.mjs', node: '/usr/bin/node' };
    const table = suggestTasksToml(server).join('\n');
    expect(table).toContain('[mcp_servers.wevir_tasks]');
    expect(table).toContain('command = "/usr/bin/node"');
    expect(table).toContain('args = ["/h/wevir-suggest-tasks.mjs"]');
    expect(table).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    expect(table).toContain('default_tools_approval_mode = "approve"');
    expect(table).toContain('enabled_tools = ["suggest_tasks"]');
    expect(
      renderConfigToml({ providers: [], gatewayBaseURL: () => '', suggestTasks: server }),
    ).toContain(table);
    expect(renderChatgptConfigToml(undefined, server)).toContain(table);
    expect(renderConfigToml({ providers: [], gatewayBaseURL: () => '' })).not.toContain(
      'mcp_servers',
    );
  });

  it('参数里的建议：去掉标题或说明为空的，去掉首尾空白，最多五项；也接受 JSON 字符串', () => {
    expect(
      suggestedTasksOf({
        tasks: [
          { title: ' 补测试 ', prompt: ' 跑通 pnpm test ', reason: ' 没覆盖 ' },
          { title: '', prompt: 'x' },
          { title: 'y', prompt: 3 },
          { title: 'z', prompt: 'w', reason: '  ' },
        ],
      }),
    ).toEqual([
      { title: '补测试', prompt: '跑通 pnpm test', reason: '没覆盖' },
      { title: 'z', prompt: 'w' },
    ]);
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, prompt: 'p' }));
    expect(suggestedTasksOf({ tasks: many })).toHaveLength(SUGGEST_TASKS_MAX);
    expect(suggestedTasksOf(JSON.stringify({ tasks: [{ title: 'a', prompt: 'b' }] }))).toEqual([
      { title: 'a', prompt: 'b' },
    ]);
    expect(suggestedTasksOf('not json')).toEqual([]);
    expect(suggestedTasksOf(null)).toEqual([]);
  });
});

describe('映射', () => {
  const item = (status: string, server = 'wevir_tasks') => ({
    type: 'mcpToolCall',
    id: 'call_1',
    server,
    tool: 'suggest_tasks',
    status,
    arguments: { tasks: [{ title: 'a', prompt: 'b' }] },
    result: null,
    error: null,
  });
  const map = (mapper: CodexEventMapper, status: string, server?: string) =>
    mapper.map('item/completed', { threadId: 't', turnId: 'u', item: item(status, server) });

  it('suggest_tasks 完成后紧跟 tasks.suggested；失败的、别的 MCP 服务的不报', () => {
    const mapper = new CodexEventMapper('t');
    mapper.map('item/started', { threadId: 't', turnId: 'u', item: item('inProgress') });
    expect(map(mapper, 'completed').map((e) => e.type)).toEqual([
      'tool.finished',
      'tasks.suggested',
    ]);
    expect(
      new CodexEventMapper('t').map('item/completed', {
        threadId: 't',
        turnId: 'u',
        item: item('completed'),
      }),
    ).toContainEqual({
      type: 'tasks.suggested',
      engineSessionId: 't',
      toolCallId: 'call_1',
      tasks: [{ title: 'a', prompt: 'b' }],
    });
    expect(map(new CodexEventMapper('t'), 'failed').map((e) => e.type)).not.toContain(
      'tasks.suggested',
    );
    expect(map(new CodexEventMapper('t'), 'completed', 'other').map((e) => e.type)).not.toContain(
      'tasks.suggested',
    );
  });

  it('Wevir 的 MCP 服务正常启动不出事件，起不来的留 engine.raw', () => {
    const mapper = new CodexEventMapper('t');
    const status = (name: string, value: string) =>
      mapper.map('mcpServer/startupStatus/updated', { threadId: 't', name, status: value });
    expect(status('wevir_tasks', 'starting')).toEqual([]);
    expect(status('wevir_tasks', 'ready')).toEqual([]);
    expect(status('wevir_tasks', 'failed')).toMatchObject([{ type: 'engine.raw' }]);
    expect(status('other', 'ready')).toMatchObject([{ type: 'engine.raw' }]);
  });
});
