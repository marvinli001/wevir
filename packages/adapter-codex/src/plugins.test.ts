// 建会话前同步 skill 与连接器（plugins.ts）：什么时候不必再让 Codex 列一遍 skill。

import type { EnginePluginConfig } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import type { CodexProcess } from './codex-process.js';
import { HARDENING_TABLES } from './config.js';
import { CodexPlugins, type CodexPluginThread, pluginsToml } from './plugins.js';

function setup() {
  const calls: string[] = [];
  const hooks: { onList?: () => void; connected?: Set<string> } = {};
  let generation = 1;
  const process = {
    state: 'ready',
    get generation() {
      return generation;
    },
    request: async (
      method: string,
      params: { cwds?: string[]; threadId?: string; serverName?: string },
    ) => {
      if (method === 'mcpServerStatus/list') {
        const asked = `${params.threadId ?? '-'} ${params.serverName}`;
        calls.push(`${method} ${asked}`);
        const status = hooks.connected?.has(asked) ? 'connected' : 'starting';
        return { data: [{ name: params.serverName, runtimeStatus: status, tools: {} }] };
      }
      calls.push(method === 'skills/list' ? `${method} ${params.cwds?.join(',')}` : method);
      if (method === 'skills/list') {
        hooks.onList?.();
        return { data: [{ skills: [] }] };
      }
      return {};
    },
  } as unknown as CodexProcess;
  const threads: CodexPluginThread[] = [];
  const plugins = new CodexPlugins(
    process,
    () => threads,
    () => {},
  );
  let config: EnginePluginConfig = { skillsRoot: '/skills', connectors: [], skills: [] };
  plugins.source = { read: async () => config, changed: () => {} };
  const lists = () => calls.filter((call) => call.startsWith('skills/list'));
  const statusCalls = () =>
    calls
      .filter((call) => call.startsWith('mcpServerStatus/list'))
      .map((call) => call.slice('mcpServerStatus/list '.length));
  return {
    plugins,
    threads,
    lists,
    statusCalls,
    hooks,
    setConfig: (next: EnginePluginConfig) => {
      config = next;
    },
    restart: () => {
      generation += 1;
    },
  };
}

describe('CodexPlugins.sync', () => {
  it('目录开着 thread、上次列过、配置没变时不再列 skill', async () => {
    const h = setup();
    await h.plugins.sync('/a');
    expect(h.lists()).toEqual(['skills/list /a']);
    // /a 还没有 thread（Codex 不盯着它）：再建也要列。
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(2);
    // 列完紧接着在 /a 开了 thread：之后在 /a 建会话、重读插件都不用再列。
    h.threads.push({ id: 't1', cwd: '/a', connectors: new Set() });
    await h.plugins.sync('/a');
    await h.plugins.sync();
    expect(h.lists()).toHaveLength(2);
    // 新目录、Codex 报了 skills/changed、配置变了、进程换代：都重列。
    await h.plugins.sync('/b');
    expect(h.lists().at(-1)).toBe('skills/list /b,/a');
    h.plugins.notification('skills/changed');
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(4);
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(4);
    h.setConfig({
      skillsRoot: '/skills',
      connectors: [],
      skills: [{ name: 'x', path: '/s/x/SKILL.md', enabled: false }],
    });
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(5);
    h.restart();
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(6);
  });

  it('列的时候收到的 skills/changed 让下次照样重列', async () => {
    const h = setup();
    h.threads.push({ id: 't1', cwd: '/a', connectors: new Set() });
    h.hooks.onList = () => {
      h.hooks.onList = undefined;
      h.plugins.notification('skills/changed');
    };
    await h.plugins.sync('/a');
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(2);
    await h.plugins.sync('/a');
    expect(h.lists()).toHaveLength(2);
  });
});

describe('CodexPlugins.status', () => {
  it('按名字问连接器，用开着的 thread 已有的连接，连上一个就不再问别的', async () => {
    const h = setup();
    const stdio = { transport: 'stdio' as const, command: 'mcp' };
    h.setConfig({
      skillsRoot: '/skills',
      connectors: [
        { name: 'docs', config: stdio, enabled: true },
        { name: 'off', config: stdio, enabled: false },
      ],
      skills: [],
    });
    await h.plugins.sync('/a');
    h.threads.push(
      { id: 't1', cwd: '/a', connectors: new Set(['proj']) },
      { id: 't2', cwd: '/a', connectors: new Set() },
      { id: 't3', cwd: '/b', connectors: new Set() },
    );
    h.hooks.connected = new Set(['t2 docs', 't1 proj']);
    expect(await h.plugins.status()).toEqual([
      { name: 'docs', status: 'connected', tools: [] },
      { name: 'proj', status: 'connected', tools: [] },
    ]);
    expect(h.statusCalls()).toEqual(['t1 docs', 't1 proj', 't2 docs']);
    // 没有开着的 thread：只问 Host 的连接器，不让 Codex 把全部 MCP 服务起一遍。
    h.threads.length = 0;
    await h.plugins.status();
    expect(h.statusCalls().slice(3)).toEqual(['- docs']);
  });
});

describe('pluginsToml', () => {
  it('打开 skills 列表时 Codex 自带的 skills 仍关着，内置的 imagegen 只有 Wevir 那一份', () => {
    const toml = pluginsToml(HARDENING_TABLES.join('\n'), {
      skillsRoot: '/skills',
      connectors: [],
      skills: [{ name: 'imagegen', path: '/prompts/skills/imagegen/SKILL.md', enabled: true }],
    });
    expect(toml).toContain('[skills]\ninclude_instructions = true');
    expect(toml).toContain('[skills.bundled]\nenabled = false');
  });
});
