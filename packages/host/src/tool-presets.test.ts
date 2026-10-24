// 工具预设的纯逻辑（tool-presets.ts）：分组、规范写法、与角色取交集、按预设裁剪说明。

import { join } from 'node:path';
import type { HostId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_TOOLS_INSTRUCTIONS, AppTools } from './app-tools.js';
import { BrowserBroker } from './browser-broker.js';
import { EventStore } from './event-store.js';
import { LspManager } from './lsp/manager.js';
import { MemoryStore } from './memory.js';
import { PluginRegistry } from './plugins.js';
import { ProcessManager } from './processes.js';
import { BUILTIN_ROLES, RoleStore, roleAllowsTool } from './roles.js';
import { SessionManager } from './session-manager.js';
import { TaskBoardStore } from './task-board.js';
import { useStorages, useTempDir } from './test-utils.js';
import { ToolOutputStore } from './tool-output.js';
import {
  CORE_TOOL_GROUPS,
  instructionLineTools,
  listedToolInstructions,
  normalizeToolPreset,
  OPTIONAL_TOOL_GROUPS,
  presetAllowsTool,
  TOOL_GROUPS,
  type ToolPreset,
  toolGroupContents,
  toolGroupOf,
  toolPresetGroups,
  toolsAllowed,
} from './tool-presets.js';

const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** 所有工具都挂上的 AppTools（同 wevir-host：浏览器、插件、进程、LSP、记忆、角色、任务清单）。 */
function allTools(): AppTools {
  const root = tempDir();
  const storage = storages.open(join(root, 'data'));
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const adapter = new EchoAdapter({});
  const sessions = new SessionManager({ storage, events, adapter });
  const processes = new ProcessManager({
    output: new ToolOutputStore(join(root, 'out')),
    onNotice: () => {},
  });
  cleanups.push(async () => {
    await processes.close();
    await sessions.dispose();
    await adapter.dispose();
  });
  return new AppTools({
    storage,
    events,
    sessions,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => 'queue',
    browser: new BrowserBroker(),
    plugins: new PluginRegistry({
      home: join(root, 'data'),
      userHome: join(root, 'user'),
      roots: () => [],
      adapter,
    }),
    processes,
    lsp: new LspManager(),
    memory: new MemoryStore({ dir: join(root, 'memory') }),
    roles: new RoleStore({ dir: join(root, 'roles') }),
    tasks: new TaskBoardStore({ dir: join(root, 'tasks') }),
  });
}

const CORE: ToolPreset = { id: 'core' };
const FULL: ToolPreset = { id: 'full' };

describe('工具分组', () => {
  it('Host 的每个应用级工具都属于一个组；core 留 22 个，另 4 组是浏览器 29、LSP 7、进程 6、插件 4', () => {
    const tools = allTools().tools;
    expect(tools).toHaveLength(68);
    expect(tools.filter((tool) => toolGroupOf(tool.name) === undefined)).toEqual([]);
    const contents = toolGroupContents(tools);
    expect(Object.fromEntries(contents.map((group) => [group.id, group.tools.length]))).toEqual({
      sessions: 9,
      catalog: 2,
      tasks: 3,
      memory: 4,
      workbench: 4,
      browser: 29,
      lsp: 7,
      processes: 6,
      plugins: 4,
    });
    expect(contents.filter((group) => group.core).map((group) => group.id)).toEqual(
      CORE_TOOL_GROUPS,
    );
    expect(toolsAllowed(tools, { preset: CORE }).map((tool) => tool.name)).toEqual(
      contents
        .filter((group) => group.core)
        .flatMap((group) => group.tools)
        .sort(byOrder(tools)),
    );
    expect(toolsAllowed(tools, { preset: CORE })).toHaveLength(22);
  });

  it('core 留下协作入口：读写会话、记忆读写、任务清单、模型与角色、展示与交文件', () => {
    for (const name of [
      'wevir_session_list',
      'wevir_session_read',
      'wevir_session_create',
      'wevir_session_send',
      'wevir_memory_list',
      'wevir_memory_read',
      'wevir_memory_save',
      'wevir_memory_delete',
      'wevir_tasks',
      'wevir_task_create',
      'wevir_task_update',
      'wevir_models',
      'wevir_roles',
      'wevir_share_file',
      'wevir_mark_chapter',
      'wevir_report_findings',
      'wevir_show',
    ]) {
      expect(presetAllowsTool(CORE, name), name).toBe(true);
    }
    for (const name of [
      'browser_snapshot',
      'lsp_hover',
      'wevir_process_start',
      'wevir_plugin_install',
    ]) {
      expect(presetAllowsTool(CORE, name), name).toBe(false);
    }
  });

  it('认不出的工具名只在 full 里', () => {
    expect(toolGroupOf('wevir_something_new')).toBeUndefined();
    expect(presetAllowsTool(FULL, 'wevir_something_new')).toBe(true);
    expect(presetAllowsTool(undefined, 'wevir_something_new')).toBe(true);
    expect(
      presetAllowsTool({ id: 'core', groups: [...OPTIONAL_TOOL_GROUPS] }, 'wevir_something_new'),
    ).toBe(false);
  });

  it('规范写法：full 不带组；core 的组去重、去掉本来就有的、按固定顺序', () => {
    expect(normalizeToolPreset({ id: 'full', groups: ['browser'] })).toEqual({ id: 'full' });
    expect(normalizeToolPreset({ id: 'core' })).toEqual({ id: 'core' });
    expect(normalizeToolPreset({ id: 'core', groups: [] })).toEqual({ id: 'core' });
    expect(normalizeToolPreset({ id: 'core', groups: ['memory', 'sessions'] })).toEqual({
      id: 'core',
    });
    expect(
      normalizeToolPreset({ id: 'core', groups: ['plugins', 'browser', 'plugins', 'lsp'] }),
    ).toEqual({ id: 'core', groups: ['browser', 'lsp', 'plugins'] });
    expect(toolPresetGroups(undefined)).toBeUndefined();
    expect(toolPresetGroups(FULL)).toBeUndefined();
    expect([...(toolPresetGroups({ id: 'core', groups: ['lsp'] }) ?? [])]).toEqual([
      ...CORE_TOOL_GROUPS,
      'lsp',
    ]);
    expect(TOOL_GROUPS).toEqual([...CORE_TOOL_GROUPS, ...OPTIONAL_TOOL_GROUPS]);
  });
});

describe('与角色取交集', () => {
  const presets: ToolPreset[] = [
    FULL,
    CORE,
    { id: 'core', groups: ['browser'] },
    { id: 'core', groups: [...OPTIONAL_TOOL_GROUPS] },
  ];

  it('预设从不放宽角色：每个内置角色 × 每个预设，留下的都是角色允许、预设也留的', () => {
    const tools = allTools().tools;
    for (const role of BUILTIN_ROLES) {
      const byRole = tools.filter((tool) => roleAllowsTool(role, tool));
      for (const preset of presets) {
        const kept = toolsAllowed(tools, { role, preset });
        for (const tool of kept) {
          expect(roleAllowsTool(role, tool), `${role.name} ${tool.name}`).toBe(true);
          expect(presetAllowsTool(preset, tool.name), `${role.name} ${tool.name}`).toBe(true);
        }
        expect(kept).toEqual(byRole.filter((tool) => presetAllowsTool(preset, tool.name)));
      }
      // full 与没有预设时就是角色自己的。
      expect(toolsAllowed(tools, { role, preset: FULL })).toEqual(byRole);
      expect(toolsAllowed(tools, { role })).toEqual(byRole);
    }
  });

  it('explorer 选 full 仍只有只读工具；worker 选 core 是 core 去掉它不许的', () => {
    const tools = allTools().tools;
    const explorer = BUILTIN_ROLES.find((role) => role.name === 'explorer');
    const worker = BUILTIN_ROLES.find((role) => role.name === 'worker');
    const full = toolsAllowed(tools, { role: explorer, preset: FULL }).map((tool) => tool.name);
    expect(full).not.toContain('wevir_session_create');
    expect(full).toContain('browser_snapshot');
    const withBrowser = toolsAllowed(tools, {
      role: explorer,
      preset: { id: 'core', groups: ['browser'] },
    }).map((tool) => tool.name);
    expect(withBrowser).toContain('browser_snapshot');
    expect(withBrowser).not.toContain('browser_click');
    expect(withBrowser).not.toContain('lsp_hover');
    const core = toolsAllowed(tools, { role: worker, preset: CORE }).map((tool) => tool.name);
    expect(core).toContain('wevir_session_list');
    expect(core).not.toContain('wevir_session_create');
    expect(core).not.toContain('wevir_process_start');
    expect(core).toHaveLength(17);
  });

  it('没有角色也没有预设时原样返回同一个数组', () => {
    const tools = allTools().tools;
    expect(toolsAllowed(tools, {})).toBe(tools);
    expect(toolsAllowed(tools, { preset: FULL })).toBe(tools);
  });
});

describe('按列出的工具裁剪说明', () => {
  it('说明里每一条讲工具的行都认得出它讲的工具，且都归得到组', () => {
    const lines = APP_TOOLS_INSTRUCTIONS.split('\n').filter((line) => /^- [a-z]/.test(line));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const tools = instructionLineTools(line);
      expect(tools, line).toBeDefined();
      for (const tool of tools ?? [])
        expect(toolGroupOf(tool.replace(/\*$/, '')), tool).toBeDefined();
    }
    expect(instructionLineTools('- Results over about 8 KB are saved to a file')).toBeUndefined();
    expect(instructionLineTools('- wevir_tasks / wevir_task_create: a list')).toEqual([
      'wevir_tasks',
      'wevir_task_create',
    ]);
  });

  it('全部工具都列出时逐字节不变', () => {
    const names = allTools().tools.map((tool) => tool.name);
    const everything = [
      ...names,
      'computer_click',
      'simulator_control',
      'wevir_tuning_status',
      'wevir_preview_start',
      'wevir_workspace_readiness',
      'wevir_automations',
    ];
    expect(listedToolInstructions(APP_TOOLS_INSTRUCTIONS, everything)).toBe(APP_TOOLS_INSTRUCTIONS);
  });

  it('core 去掉浏览器、LSP、进程、插件那几行，别的行原样；另加的组留下它那一行', () => {
    const tools = allTools().tools;
    const listed = (preset: ToolPreset) =>
      listedToolInstructions(
        APP_TOOLS_INSTRUCTIONS,
        toolsAllowed(tools, { preset }).map((tool) => tool.name),
      );
    const core = listed(CORE);
    for (const gone of [
      '- browser_*',
      '- computer_*',
      '- simulator_*',
      '- lsp_*',
      '- wevir_process_*',
      '- wevir_preview_*',
      '- wevir_workspace_readiness',
      '- wevir_plugins_list',
      '- wevir_tuning_*',
    ]) {
      expect(core).not.toContain(gone);
    }
    for (const kept of [
      '- wevir_session_list',
      '- wevir_session_create',
      '- wevir_memory_*',
      '- wevir_tasks',
      '- wevir_models',
      '- wevir_show',
      '- Results over about 8 KB',
      'Sessions you open or message cannot get broader permissions',
    ]) {
      expect(core).toContain(kept);
    }
    const withLsp = listed({ id: 'core', groups: ['lsp'] });
    expect(withLsp).toContain('- lsp_*');
    expect(withLsp).not.toContain('- browser_*');
  });

  it('一行讲的工具有一个列出就留下', () => {
    const line = '- wevir_session_send / wevir_session_wait: follow up';
    expect(listedToolInstructions(line, ['wevir_session_wait'])).toBe(line);
    expect(listedToolInstructions(line, ['wevir_session_list'])).toBe('');
    expect(listedToolInstructions('- lsp_*: code', ['lsp_hover'])).toBe('- lsp_*: code');
  });
});

function byOrder(tools: readonly { name: string }[]) {
  const index = new Map(tools.map((tool, at) => [tool.name, at]));
  return (a: string, b: string) => (index.get(a) ?? 0) - (index.get(b) ?? 0);
}
