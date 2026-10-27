// 工具面的体积预算：按产品配置挂齐服务的 AppTools（不起引擎），算默认会话、core 预设与各内置角色的 `tools/list`（MCP 原形）字节与
// 说明字节，超过预算就失败并列出最大的 10 个工具。加工具要么挤进预算，要么改预算（改预算是一个看得见的决定）。
//
// 产品默认的 Host 设置：电脑操作与写作风格关着，iOS 模拟器与自动记忆开着（装了模拟器 helper 的 Mac 上就是这样）。频道工具只给
// 频道里的会话，这里不算。

import { join } from 'node:path';
import type { HostId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppTool } from './app-mcp.js';
import { APP_TOOLS_INSTRUCTIONS, AppTools } from './app-tools.js';
import { BrowserBroker } from './browser-broker.js';
import { channelToolAllowed } from './channels/tools.js';
import { EventStore } from './event-store.js';
import { LspManager } from './lsp/manager.js';
import { MemoryStore } from './memory.js';
import { PluginRegistry } from './plugins.js';
import { ProcessManager } from './processes.js';
import { BUILTIN_ROLES, RoleStore } from './roles.js';
import { SessionManager } from './session-manager.js';
import { TaskBoardStore } from './task-board.js';
import { useStorages, useTempDir } from './test-utils.js';
import { dispatchTools } from './tool-dispatch.js';
import { ToolOutputStore } from './tool-output.js';
import {
  CORE_TIER_TOOLS,
  listedToolInstructions,
  type ToolPreset,
  toolsAllowed,
  toolTier,
} from './tool-presets.js';

/** 说明正文的上限（字符）：Claude Code 只取 MCP 服务说明的前 4,096 个字符，记忆索引另算。 */
const INSTRUCTIONS_MAX_CHARS = 4000;

/**
 * 各场景的预算（字节）：`tools` 是 `tools/list` 的 MCP 原形，`instructions` 是按列出的工具裁剪后的说明。2026-10-25 实测：默认会话
 * 84 个工具 96,255 / 3,716，core 37,716 / 2,704，只读角色 38,077 / 3,340，worker 86,880 / 3,410；各留 5% 左右的余量。
 */
const BUDGETS: Record<string, { tools: number; instructions: number }> = {
  default: { tools: 101_000, instructions: 3_900 },
  core: { tools: 39_600, instructions: 2_850 },
  advisor: { tools: 40_000, instructions: 3_500 },
  explorer: { tools: 40_000, instructions: 3_500 },
  planner: { tools: 40_000, instructions: 3_500 },
  reviewer: { tools: 40_000, instructions: 3_500 },
  worker: { tools: 91_200, instructions: 3_600 },
};

/**
 * 常驻层（`toolTier` 为 core 的工具）的 MCP 原形字节：工具搜索打开时首个请求里只有它们。2026-10-25 实测 20,023；2026-10-27
 * 回合收尾的 `wevir_wrap_up`（0.128.0，每个干活的回合都要调，不能按需加载）进常驻层，多 1,259，预算从 21,000 提到 22,000。
 */
const RESIDENT_MAX_BYTES = 22_000;
/**
 * 没有自带工具搜索的引擎（OpenCode）登记的：常驻层加上搜索与两个分发工具（2026-10-25 实测 20 个、21,810 字节；2026-10-27 加
 * `wevir_wrap_up` 后 23,627，预算从 23,000 提到 24,000）。
 */
const DISPATCH_MAX_BYTES = 24_000;

const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** 只用来登记工具的服务：列工具时不会调用它们。 */
const unused = <T>(): T => ({}) as T;

/** 产品配置的 AppTools：wevir-host 挂的服务都挂上。 */
function productTools(): AppTools {
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
    computer: { broker: unused(), enabled: () => false },
    simulator: { service: unused(), enabled: () => true },
    plugins: new PluginRegistry({
      home: join(root, 'data'),
      userHome: join(root, 'user'),
      roots: () => [],
      adapter,
    }),
    processes,
    readiness: unused(),
    previews: unused(),
    lsp: new LspManager(),
    opinions: unused(),
    memory: new MemoryStore({ dir: join(root, 'memory') }),
    writingStyle: { store: unused(), guide: '', enabled: () => false },
    tuning: { proposals: unused(), trials: unused(), tuning: unused(), spillDir: root },
    roles: new RoleStore({ dir: join(root, 'roles') }),
    tasks: new TaskBoardStore({ dir: join(root, 'tasks') }),
    automations: unused(),
    channels: unused(),
    retro: unused(),
    search: unused(),
  });
}

/** `tools/list` 里一项的字节（同 app-mcp.ts 的形状）。 */
function listedBytes(tool: AppTool): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    }),
  );
}

async function scenarios(): Promise<Array<{ name: string; tools: readonly AppTool[] }>> {
  const app = productTools();
  // Host 设置（调用方不明时只按设置过滤），再去掉频道工具。
  const base = (await app.filterTools(undefined, app.tools)).filter((tool) =>
    channelToolAllowed(tool.name, undefined),
  );
  const core: ToolPreset = { id: 'core' };
  return [
    { name: 'default', tools: base },
    { name: 'core', tools: toolsAllowed(base, { preset: core }) },
    ...BUILTIN_ROLES.map((role) => ({ name: role.name, tools: toolsAllowed(base, { role }) })),
  ];
}

describe('工具面体积预算', () => {
  it(`说明正文不超过 ${INSTRUCTIONS_MAX_CHARS} 字符`, () => {
    expect(APP_TOOLS_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });

  it('默认会话、core 预设与各内置角色都在预算之内', async () => {
    const all = await scenarios();
    expect(all.map((scenario) => scenario.name).sort()).toEqual(Object.keys(BUDGETS).sort());
    const over: string[] = [];
    for (const { name, tools } of all) {
      const budget = BUDGETS[name] as { tools: number; instructions: number };
      const toolBytes = tools.reduce((sum, tool) => sum + listedBytes(tool), 0);
      const instructionBytes = Buffer.byteLength(
        listedToolInstructions(
          APP_TOOLS_INSTRUCTIONS,
          tools.map((tool) => tool.name),
        ),
      );
      if (toolBytes <= budget.tools && instructionBytes <= budget.instructions) continue;
      const largest = [...tools]
        .sort((a, b) => listedBytes(b) - listedBytes(a))
        .slice(0, 10)
        .map((tool) => `  ${tool.name} ${listedBytes(tool)} B`);
      over.push(
        `${name}: ${tools.length} tools ${toolBytes} B (budget ${budget.tools}), instructions ${instructionBytes} B (budget ${budget.instructions}); largest:\n${largest.join('\n')}`,
      );
    }
    expect(over, over.join('\n\n')).toEqual([]);
  });

  it(`常驻层（核心工具）不超过 ${RESIDENT_MAX_BYTES} 字节`, async () => {
    const [plain] = await scenarios();
    const resident = (plain?.tools ?? []).filter((tool) => toolTier(tool.name) === 'core');
    expect(resident.map((tool) => tool.name).sort()).toEqual([...CORE_TIER_TOOLS].sort());
    const bytes = resident.reduce((sum, tool) => sum + listedBytes(tool), 0);
    const largest = [...resident]
      .sort((a, b) => listedBytes(b) - listedBytes(a))
      .slice(0, 10)
      .map((tool) => `${tool.name} ${listedBytes(tool)} B`);
    expect(bytes, `resident ${bytes} B; largest: ${largest.join(', ')}`).toBeLessThanOrEqual(
      RESIDENT_MAX_BYTES,
    );
  });

  it(`dispatch 列法（常驻层与搜索、分发工具）不超过 ${DISPATCH_MAX_BYTES} 字节`, async () => {
    const [plain] = await scenarios();
    const resident = (plain?.tools ?? []).filter((tool) => toolTier(tool.name) === 'core');
    const unused = () => Promise.reject(new Error('not called'));
    const listed = [
      ...resident,
      ...dispatchTools({ searchable: unused, resolve: unused, run: unused }),
    ];
    const bytes = listed.reduce((sum, tool) => sum + listedBytes(tool), 0);
    expect(bytes).toBeLessThanOrEqual(DISPATCH_MAX_BYTES);
  });

  it('每个工具都归得到层', async () => {
    const [plain] = await scenarios();
    const app = productTools();
    const untiered = app.tools.filter((tool) => toolTier(tool.name) === undefined);
    expect(untiered.map((tool) => tool.name)).toEqual([]);
    expect(plain?.tools.length).toBeGreaterThan(CORE_TIER_TOOLS.length);
  });
});
