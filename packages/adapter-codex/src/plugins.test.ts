// 建会话前同步 skill 与连接器（plugins.ts）：什么时候不必再让 Codex 列一遍 skill。

import type { EnginePluginConfig } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import type { CodexProcess } from './codex-process.js';
import { CodexPlugins } from './plugins.js';

function setup() {
  const calls: string[] = [];
  const hooks: { onList?: () => void } = {};
  let generation = 1;
  const process = {
    state: 'ready',
    get generation() {
      return generation;
    },
    request: async (method: string, params: { cwds?: string[] }) => {
      calls.push(method === 'skills/list' ? `${method} ${params.cwds?.join(',')}` : method);
      if (method === 'skills/list') {
        hooks.onList?.();
        return { data: [{ skills: [] }] };
      }
      return {};
    },
  } as unknown as CodexProcess;
  const threads: Array<{ id: string; cwd: string }> = [];
  const plugins = new CodexPlugins(
    process,
    () => threads,
    () => {},
  );
  let config: EnginePluginConfig = { skillsRoot: '/skills', connectors: [], skills: [] };
  plugins.source = { read: async () => config, changed: () => {} };
  const lists = () => calls.filter((call) => call.startsWith('skills/list'));
  return {
    plugins,
    threads,
    lists,
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
    h.threads.push({ id: 't1', cwd: '/a' });
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
    h.threads.push({ id: 't1', cwd: '/a' });
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
