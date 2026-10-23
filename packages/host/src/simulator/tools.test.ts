// iOS 模拟器的应用级工具（0.122.0）：`simulator_build` 经后台进程跑（假的）xcodebuild，返回 .app 与 bundle id；失败时摘出 error 行。
// `launch` 装 .app 的审批归类：本会话构建的、完全访问的会话不问，其余问；只给 bundle_id 不问。工具的审批表与注解。

import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppTool } from '../app-mcp.js';
import type { EventStore } from '../event-store.js';
import { ProcessManager } from '../processes.js';
import { T0, useStorages, useTempDir } from '../test-utils.js';
import { ToolOutputStore } from '../tool-output.js';
import { toolGroupOf } from '../tool-presets.js';
import { SimulatorService } from './service.js';
import { Simctl } from './simctl.js';
import { BOOTED, fakeHelperBin, fakeSimctl } from './test-helpers.js';
import {
  formatAxTree,
  resolveDevice,
  SIMULATOR_TOOLS,
  shellQuote,
  simulatorTools,
  swipePoints,
} from './tools.js';

const posix = process.platform !== 'win32';
const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const tempDir = useTempDir();
const storages = useStorages();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 假的 xcodebuild：`-list` 列一个 scheme；scheme `Broken` 失败；否则在 DerivedData 里放一个 .app。 */
const FAKE_XCODEBUILD = `#!/bin/sh
derived=""; config="Debug"; scheme=""
while [ $# -gt 0 ]; do
  case "$1" in
    -derivedDataPath) derived="$2"; shift ;;
    -configuration) config="$2"; shift ;;
    -scheme) scheme="$2"; shift ;;
  esac
  shift
done
if [ "$scheme" = "Broken" ]; then
  echo "Compiling..."
  echo "/src/App.swift:3:5: error: cannot find 'foo' in scope"
  exit 65
fi
dir="$derived/Build/Products/$config-iphonesimulator/$scheme.app"
mkdir -p "$dir"
echo "plist" > "$dir/Info.plist"
echo "** BUILD SUCCEEDED **"
`;

function setup(permissionMode: 'on_request' | 'full_access' = 'on_request') {
  const root = realpathSync(tempDir());
  const project = join(root, 'project');
  mkdirSync(join(project, 'Demo.xcodeproj'), { recursive: true });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'xcodebuild'), FAKE_XCODEBUILD);
  chmodSync(join(bin, 'xcodebuild'), 0o755);
  const storage = storages.open(join(root, 'data'));
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: project,
    displayName: 'project',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.sessions.insert({
    id: SES,
    workspaceId: 'ws_1',
    cwd: project,
    engine: 'echo',
    engineSessionId: 'engine-1',
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
    title: '',
    titleSource: 'first_prompt',
    state: 'running',
    lastSeq: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  const simctl = fakeSimctl();
  const service = new SimulatorService({
    bin: fakeHelperBin(root),
    dir: join(root, 'simulator'),
    streamBase: () => 'ws://127.0.0.1:1',
    simctl: new Simctl(simctl.run),
    sandbox: false,
  });
  cleanups.push(() => service.dispose());
  const processes = new ProcessManager({
    output: new ToolOutputStore(join(root, 'tool-output')),
    onNotice: () => {},
    env: { ...process.env, SHELL: '/bin/sh', PATH: `${bin}:${process.env.PATH}` },
  });
  cleanups.push(() => processes.close());
  const approvals: unknown[] = [];
  let approve = true;
  const events = {
    snapshot: () => ({ session: { permissionMode, activeTurn: { turnId: 'trn_1' } } }),
  } as unknown as EventStore;
  const tools = simulatorTools({
    service,
    enabled: () => true,
    storage,
    events,
    sessions: {
      requestAppToolApproval: async (_session, _call, detail) => {
        approvals.push(detail);
        return approve;
      },
    },
    processes,
    xcodebuild: join(bin, 'xcodebuild'),
    exec: async (file, args) => {
      if (file === 'xcodebuild') return JSON.stringify({ project: { schemes: ['Demo'] } });
      if (file.endsWith('plutil')) return 'com.example.Demo\n';
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    },
  });
  const tool = (name: string) => tools.find((candidate) => candidate.name === name) as AppTool;
  const call = (name: string, args: Record<string, unknown>) =>
    tool(name).call(args, { sessionId: SES, signal: new AbortController().signal });
  return {
    tools,
    call,
    approvals,
    simctl,
    project,
    deny: () => {
      approve = false;
    },
    service,
  };
}

describe('工具的形状', () => {
  it('只有两个工具，simulator_control 不用批准、simulator_build 照命令执行，都归在浏览器一组', () => {
    expect(SIMULATOR_TOOLS).toEqual(['simulator_control', 'simulator_build']);
    expect(APP_TOOLS_NO_APPROVAL).toContain('simulator_control');
    expect(APP_TOOLS_NO_APPROVAL).not.toContain('simulator_build');
    expect(toolGroupOf('simulator_control')).toBe('browser');
    expect(toolGroupOf('simulator_build')).toBe('browser');
  });

  it('滑动按 60 Hz 取样，首尾是起点与终点', () => {
    const points = swipePoints({ x: 0, y: 100 }, { x: 0, y: 0 }, 0.1);
    expect(points[0]).toEqual({ x: 0, y: 100, dtMs: 0 });
    expect(points.at(-1)).toMatchObject({ x: 0, y: 0 });
    expect(points).toHaveLength(7);
  });

  it('无障碍树写成缩进的行：角色、名字、#标识、引用、取整的点坐标、值与状态；不认识的形状给 JSON', () => {
    expect(
      formatAxTree({
        root: {
          id: '@a1',
          role: 'Application',
          label: 'Demo',
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              id: '@a2',
              role: 'TextField',
              label: 'Name',
              identifier: 'name',
              value: 'Ada',
              frame: { x: 10.4, y: 20.6, width: 100, height: 44 },
              focused: true,
            },
            { id: '@a3', role: 'Button', label: 'Save', enabled: false },
          ],
        },
        count: 3,
        truncated: true,
      }),
    ).toBe(
      [
        'Application "Demo" @a1 (0,0 402×874)',
        '  TextField "Name" #name @a2 (10,21 100×44) value="Ada" focused',
        '  Button "Save" @a3 disabled',
        '3 elements (truncated: describe_ui with x and y for one area). Frames are (x,y width×height) in points; tap the center.',
      ].join('\n'),
    );
    expect(formatAxTree({ elements: [] })).toBe('{"elements":[]}');
  });

  it('shell 引号', () => {
    expect(shellQuote('platform=iOS Simulator,id=X')).toBe(`'platform=iOS Simulator,id=X'`);
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('/a/b.xcodeproj')).toBe('/a/b.xcodeproj');
  });
});

describe.runIf(posix)('simulator_build 与 launch', () => {
  it('注解：control 不破坏不联网，build 同 wevir_process_start', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(['simulator_control', 'simulator_build']);
    expect(tools[0]?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    expect(tools[1]?.annotations).toMatchObject({ destructiveHint: true, openWorldHint: true });
  });

  it('构建：找到唯一的工程与 scheme，返回 .app 与 bundle id；装本会话构建的不问', async () => {
    const h = setup();
    const built = await h.call('simulator_build', {});
    expect(built.isError).toBeUndefined();
    const text = (built.content[0] as { text: string }).text;
    expect(text).toContain('bundle_id: com.example.Demo');
    const appPath = /app_path: (.+)/.exec(text)?.[1] as string;
    expect(appPath).toMatch(/Debug-iphonesimulator\/Demo\.app$/);
    const launched = await h.call('simulator_control', { action: 'launch', app_path: appPath });
    expect((launched.content[0] as { text: string }).text).toContain(
      'Launched com.example.Demo (pid 4242)',
    );
    expect(h.approvals).toEqual([]);
    expect(h.simctl.calls.some((call) => call[0] === 'install' && call[2] === appPath)).toBe(true);
  });

  it('构建失败：摘出 error 行与日志路径', async () => {
    const h = setup();
    const failed = await h.call('simulator_build', { scheme: 'Broken' });
    expect(failed.isError).toBe(true);
    const text = (failed.content[0] as { text: string }).text;
    expect(text).toContain("error: cannot find 'foo' in scope");
    expect(text).not.toContain('Compiling');
    expect(text).toMatch(/Full log: .+\.log/);
  });

  it('装别处来的 .app 要批准，拒绝时什么都不装；只给 bundle_id 不问', async () => {
    const h = setup();
    const app = join(h.project, 'Other.app');
    mkdirSync(app);
    h.deny();
    const denied = await h.call('simulator_control', { action: 'launch', app_path: app });
    expect(denied.isError).toBe(true);
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]).toMatchObject({ toolName: 'mcp__wevir__simulator_control' });
    expect(h.simctl.calls.some((call) => call[0] === 'install')).toBe(false);
    const byId = await h.call('simulator_control', {
      action: 'launch',
      bundle_id: 'com.apple.Preferences',
    });
    expect(byId.isError).toBeUndefined();
    expect(h.approvals).toHaveLength(1);
  });

  it('完全访问的会话装 .app 不问', async () => {
    const h = setup('full_access');
    const app = join(h.project, 'Other.app');
    mkdirSync(app);
    writeFileSync(join(app, 'Info.plist'), 'plist');
    const launched = await h.call('simulator_control', { action: 'launch', app_path: app });
    expect(launched.isError).toBeUndefined();
    expect(h.approvals).toEqual([]);
  });

  it('设备：按名字或 UDID；没给时第一个已启动的；不在时列出可用的', async () => {
    const h = setup();
    expect((await resolveDevice(h.service, SES, undefined, 'tap')).udid).toBe(BOOTED);
    expect((await resolveDevice(h.service, SES, 'ipad air', 'attach')).name).toBe('iPad Air');
    await expect(resolveDevice(h.service, SES, 'iPad Air', 'tap')).rejects.toMatchObject({
      code: 'sim_not_booted',
    });
    await expect(resolveDevice(h.service, SES, 'Pixel', 'tap')).rejects.toThrow(
      'Available: iPhone 17 Pro, iPad Air',
    );
  });
});
