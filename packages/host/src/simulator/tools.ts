// iOS 模拟器的应用级工具（0.122.0）：为省工具描述的 token 只有两个，`simulator_control`（`action` 枚举）与 `simulator_build`。
//
// 审批：`simulator_build` 跑 xcodebuild（项目里的构建脚本），照命令执行走引擎的审批（annotations 同 `wevir_process_start`）。
// `simulator_control` 只碰模拟器，列进 `APP_TOOLS_NO_APPROVAL`；其中 `launch` 给了 `app_path` 时会安装任意 .app，由 Host 自己请用户批准
// （会话是完全访问、或这个 .app 是本会话 `simulator_build` 刚构建出来的除外）。
//
// 截图结果是图片内容项，不带 `structuredContent`（Codex 有它时只序列化它、丢掉内容项）。坐标都是设备的点。

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  type SessionId,
  SIMULATOR_BUTTONS,
  SIMULATOR_KEYS,
  type SimulatorDevice,
  type SimulatorInput,
  SimulatorInputSchema,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { type AppTool, AppToolError, type AppToolResult } from '../app-mcp.js';
import { objectSchema, WAIT_MAX_MS } from '../app-tools.js';
import { callerCwd } from '../browser-tools.js';
import type { EventStore } from '../event-store.js';
import type { ProcessManager } from '../processes.js';
import type { SessionManager } from '../session-manager.js';
import { SimulatorError } from './errors.js';
import type { SimulatorService } from './service.js';

/** 两个工具的名字（设置关着时 `filterTools` 去掉）。 */
export const SIMULATOR_TOOLS = ['simulator_control', 'simulator_build'] as const;

export const SIMULATOR_ACTIONS = [
  'list',
  'attach',
  'detach',
  'boot',
  'launch',
  'terminate',
  'screenshot',
  'tap',
  'swipe',
  'touch_path',
  'touch2_path',
  'text',
  'press_key',
  'button',
  'set_keyboard',
  'open_url',
  'rotate',
  'describe_ui',
  'logs',
] as const;
type Action = (typeof SIMULATOR_ACTIONS)[number];

/** `logs` 的默认与最长时段（秒）与最多几行。 */
const LOGS_DEFAULT_SECONDS = 30;
const LOGS_MAX_SECONDS = 600;
const LOGS_MAX_LINES = 300;
/** 构建失败时最多摘几行 `error:`。 */
const BUILD_ERROR_LINES = 40;

/** 只碰模拟器：不走引擎的审批（`launch` 装 .app 时 Host 自己问）。 */
const CONTROL = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
/** 跑项目的构建：同 `wevir_process_start`。 */
const RUN = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export interface SimulatorToolsOptions {
  service: SimulatorService;
  /** Host 设置的 `iosSimulator`（省略按开着）。 */
  enabled: () => boolean;
  storage: Storage;
  events: EventStore;
  sessions: Pick<SessionManager, 'requestAppToolApproval'>;
  /** 后台进程：`simulator_build` 的 xcodebuild 跑在这里；没有时不提供 `simulator_build`。 */
  processes?: ProcessManager;
  /** 测试用：替换 `xcodebuild -list` 与读 Info.plist。 */
  exec?: (file: string, args: readonly string[], cwd: string) => Promise<string>;
  /** 测试用：构建跑的 xcodebuild（默认在用户的登录 shell 里找 `xcodebuild`）。 */
  xcodebuild?: string;
}

export function simulatorTools(options: SimulatorToolsOptions): AppTool[] {
  /** 本会话 `simulator_build` 构建出的 .app（真实路径），`launch` 装它们不再问。 */
  const built = new Map<SessionId, Set<string>>();
  const exec = options.exec ?? execText;
  const tools: AppTool[] = [controlTool(options, built, exec)];
  if (options.processes !== undefined) {
    tools.push(buildTool(options, options.processes, built, exec));
  }
  return tools;
}

function controlTool(
  options: SimulatorToolsOptions,
  built: Map<SessionId, Set<string>>,
  exec: NonNullable<SimulatorToolsOptions['exec']>,
): AppTool {
  const { service } = options;
  return {
    name: 'simulator_control',
    title: 'Control the iOS Simulator',
    description:
      'Drive an iOS Simulator on this Mac. Simulators only: never use it for a physical device. ' +
      'action: list (devices), attach (show the device in the simulator pane next to this conversation; ' +
      'do it first), detach, boot, launch (app_path installs a .app, e.g. from simulator_build, then ' +
      'launches it; or bundle_id launches an installed app; args, env), terminate (bundle_id), ' +
      'screenshot (returns the screen; check your work with it), tap (x, y; duration over 0.5 s is a long ' +
      'press), swipe (from_x, from_y, to_x, to_y, duration), touch_path (points: [{x, y, dt_ms}], one ' +
      'finger), touch2_path (points2: [{x1, y1, x2, y2, dt_ms}], pinch or rotate), text (types text into ' +
      'the focused field), press_key (key, count), button (name), set_keyboard (state show or hide), ' +
      'open_url (url, also deep links), rotate (direction), describe_ui (accessibility tree with labels ' +
      'and frames; x and y for one point), logs (recent device log, seconds, bundle_id). ' +
      'device is a name or UDID; without it the device you attached, else the first booted one. ' +
      'Coordinates are device points from the top-left, the same units as the screenshot.',
    inputSchema: objectSchema(
      {
        action: { type: 'string', enum: [...SIMULATOR_ACTIONS] },
        device: { type: 'string', description: 'Simulator name or UDID.' },
        app_path: { type: 'string', description: 'launch: path to a built .app.' },
        bundle_id: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        x: { type: 'number' },
        y: { type: 'number' },
        duration: { type: 'number', description: 'Seconds.' },
        from_x: { type: 'number' },
        from_y: { type: 'number' },
        to_x: { type: 'number' },
        to_y: { type: 'number' },
        points: {
          type: 'array',
          items: objectSchema(
            { x: { type: 'number' }, y: { type: 'number' }, dt_ms: { type: 'number' } },
            ['x', 'y'],
          ),
        },
        points2: {
          type: 'array',
          items: objectSchema(
            {
              x1: { type: 'number' },
              y1: { type: 'number' },
              x2: { type: 'number' },
              y2: { type: 'number' },
              dt_ms: { type: 'number' },
            },
            ['x1', 'y1', 'x2', 'y2'],
          ),
        },
        text: { type: 'string' },
        key: { type: 'string', enum: [...SIMULATOR_KEYS] },
        count: { type: 'integer', minimum: 1, maximum: 100 },
        name: { type: 'string', enum: [...SIMULATOR_BUTTONS] },
        state: { type: 'string', enum: ['show', 'hide'] },
        url: { type: 'string' },
        direction: { type: 'string', enum: ['left', 'right'] },
        seconds: { type: 'integer', minimum: 1, maximum: LOGS_MAX_SECONDS },
      },
      ['action'],
    ),
    annotations: CONTROL,
    call: async (args, { sessionId, signal }) => {
      if (!options.enabled()) return disabledResult();
      const action = args.action as Action;
      if (!SIMULATOR_ACTIONS.includes(action)) {
        return errorResult(
          'sim_invalid_argument',
          `action must be one of ${SIMULATOR_ACTIONS.join(', ')}.`,
        );
      }
      try {
        if (action === 'list')
          return listResult(await service.list(), service.agentDevice(sessionId));
        if (action === 'detach') {
          const udid = service.agentDetach(sessionId);
          return text(udid === undefined ? 'No simulator was attached.' : `Detached ${udid}.`);
        }
        const device = await resolveDevice(
          service,
          sessionId,
          optionalString(args, 'device'),
          action,
        );
        switch (action) {
          case 'attach': {
            const described = await service.agentAttach(sessionId, device.udid);
            return text(
              `Attached ${label(device)}. Screen ${described.screen.width}×${described.screen.height} points ` +
                `(scale ${described.screen.scale}), ${described.orientation}. It is shown in the simulator pane next ` +
                'to this conversation.',
            );
          }
          case 'boot': {
            if (device.state === 'booted') return text(`${label(device)} is already booted.`);
            await service.ensureBooted(device.udid);
            return text(`Booted ${label(device)}.`);
          }
          case 'launch':
            return await launch(options, built, exec, sessionId, device, args, signal);
          case 'terminate': {
            const bundleId = requiredString(args, 'bundle_id');
            await service.simctl.terminate(device.udid, bundleId);
            return text(`Terminated ${bundleId}.`);
          }
          case 'screenshot':
            return await screenshot(service, device);
          case 'open_url': {
            const url = requiredString(args, 'url');
            if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new AppToolError('url needs a scheme.');
            await service.ensureBooted(device.udid);
            await service.simctl.openUrl(device.udid, url);
            service.touch(device.udid);
            return text(`Opened ${url}.`);
          }
          case 'describe_ui': {
            const x = optionalNumber(args, 'x');
            const y = optionalNumber(args, 'y');
            if ((x === undefined) !== (y === undefined)) {
              throw new AppToolError('describe_ui takes both x and y, or neither.');
            }
            const tree = await service.axTree(
              device.udid,
              x !== undefined && y !== undefined ? { x, y } : undefined,
            );
            return text(formatAxTree(tree));
          }
          case 'logs':
            return await logs(service, device, args);
          case 'set_keyboard': {
            const state = requiredString(args, 'state');
            if (state !== 'show' && state !== 'hide')
              throw new AppToolError('state is show or hide.');
            await service.configure({ udid: device.udid, softwareKeyboard: state });
            return text(state === 'show' ? 'Keyboard shown.' : 'Keyboard hidden.');
          }
          default: {
            const input = inputOf(action, args);
            const result = await service.input(device.udid, input);
            if (result.orientation !== undefined) {
              service.describe(device.udid).catch(() => {});
              return text(
                `Rotated to ${result.orientation}. Take a screenshot: the screen size changed.`,
              );
            }
            return text('Done.');
          }
        }
      } catch (error) {
        if (error instanceof SimulatorError) return errorResult(error.code, error.message);
        if (error instanceof AppToolError)
          return errorResult('sim_invalid_argument', error.message);
        throw error;
      }
    },
  };
}

function buildTool(
  options: SimulatorToolsOptions,
  processes: ProcessManager,
  built: Map<SessionId, Set<string>>,
  exec: NonNullable<SimulatorToolsOptions['exec']>,
): AppTool {
  const { service, storage, events } = options;
  return {
    name: 'simulator_build',
    title: 'Build an iOS app for the Simulator',
    description:
      "Build an iOS app with xcodebuild for the Simulator and return the .app path and bundle id to pass to simulator_control launch. Runs as a Wevir background process (visible to the user, stoppable). Without workspace or project it uses the only .xcworkspace or .xcodeproj in this session's folder, or Package.swift there. Without scheme it uses the only scheme or lists them so you can pick one. configuration defaults to Debug; device is a simulator name or UDID (default: the attached or first booted one). On failure it returns the error lines and the log path.",
    inputSchema: objectSchema(
      {
        workspace: { type: 'string' },
        project: { type: 'string' },
        scheme: { type: 'string' },
        configuration: { type: 'string' },
        device: { type: 'string' },
      },
      [],
    ),
    annotations: RUN,
    call: async (args, { sessionId, signal }) => {
      if (!options.enabled()) return disabledResult();
      try {
        const cwd = callerCwd(storage, sessionId);
        const record = storage.sessions.get(sessionId);
        if (record === undefined) throw new AppToolError('This Wevir session no longer exists.');
        const container = await findContainer(cwd, args);
        const scheme = optionalString(args, 'scheme') ?? (await pickScheme(exec, container, cwd));
        const configuration = optionalString(args, 'configuration') ?? 'Debug';
        const deviceName = optionalString(args, 'device');
        const device = await resolveDevice(service, sessionId, deviceName, 'build').catch(
          (error) => {
            if (deviceName !== undefined) throw error;
            return undefined;
          },
        );
        const derived = service.derivedDataDir(record.workspaceId);
        const destination =
          device === undefined
            ? 'generic/platform=iOS Simulator'
            : `platform=iOS Simulator,id=${device.udid}`;
        const command = [
          options.xcodebuild ?? 'xcodebuild',
          ...(container.kind === 'package' ? [] : [`-${container.kind}`, container.path]),
          '-scheme',
          scheme,
          '-configuration',
          configuration,
          '-destination',
          destination,
          '-derivedDataPath',
          derived,
          'build',
        ]
          .map(shellQuote)
          .join(' ');
        const turnId = events.snapshot(sessionId)?.session.activeTurn?.turnId;
        const started = await processes.start(sessionId, {
          command,
          cwd: container.kind === 'package' ? container.path : cwd,
          name: `xcodebuild ${scheme}`,
          notifyOnExit: false,
          ...(turnId !== undefined && { turnId }),
        });
        const waited = await processes.wait(sessionId, started.id, undefined, WAIT_MAX_MS, signal);
        if (waited.reason === 'aborted') {
          try {
            processes.signal(sessionId, started.id, 'SIGTERM');
          } catch {}
          throw new AppToolError('The build was cancelled.');
        }
        if (waited.reason === 'timeout') {
          return text(
            `The build is still running as background process ${started.id} (log: ${started.logPath}). ` +
              'Wait for it with wevir_process_wait, then call simulator_build again to get the app (it builds incrementally).',
          );
        }
        const info = processes.info(sessionId, started.id);
        if (info.exitCode !== 0) {
          const log = await readFile(info.logPath, 'utf8').catch(() => '');
          const errors = log
            .split('\n')
            .filter((line) => /(^|\s)error:/.test(line))
            .slice(0, BUILD_ERROR_LINES);
          const detail =
            errors.length > 0 ? errors.join('\n') : processes.tail(sessionId, started.id, 30);
          return {
            content: [
              {
                type: 'text',
                text: `Build failed (exit ${info.exitCode ?? info.signal}).\n${detail}\nFull log: ${info.logPath}`,
              },
            ],
            isError: true,
          };
        }
        const app = await findApp(
          join(derived, 'Build', 'Products', `${configuration}-iphonesimulator`),
          scheme,
        );
        const bundleId = await bundleIdOf(exec, app);
        const set = built.get(sessionId) ?? new Set();
        set.add(await realpath(app));
        built.set(sessionId, set);
        return text(
          `Build succeeded.\napp_path: ${app}\nbundle_id: ${bundleId}\n` +
            'Install and run it with simulator_control action launch and this app_path.',
        );
      } catch (error) {
        if (error instanceof SimulatorError) return errorResult(error.code, error.message);
        if (error instanceof AppToolError) {
          return { content: [{ type: 'text', text: error.message }], isError: true };
        }
        throw error;
      }
    },
  };
}

// ── 动作 ────────────────────────────────────────────────────────────────

async function launch(
  options: SimulatorToolsOptions,
  built: Map<SessionId, Set<string>>,
  exec: NonNullable<SimulatorToolsOptions['exec']>,
  sessionId: SessionId,
  device: SimulatorDevice,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<AppToolResult> {
  const { service } = options;
  const appPathArg = optionalString(args, 'app_path');
  let bundleId = optionalString(args, 'bundle_id');
  if (appPathArg === undefined && bundleId === undefined) {
    throw new AppToolError('launch needs app_path or bundle_id.');
  }
  const launchArgs = stringArray(args, 'args');
  const env = stringRecord(args, 'env');
  await service.ensureBooted(device.udid);
  if (appPathArg !== undefined) {
    const cwd = callerCwd(options.storage, sessionId);
    const appPath = isAbsolute(appPathArg) ? appPathArg : resolve(cwd, appPathArg);
    const info = await stat(appPath).catch(() => undefined);
    if (info?.isDirectory() !== true || !appPath.endsWith('.app')) {
      throw new AppToolError(`app_path is not a .app folder: ${appPath}`);
    }
    const real = await realpath(appPath);
    const permission = options.events.snapshot(sessionId)?.session.permissionMode;
    if (permission !== 'full_access' && built.get(sessionId)?.has(real) !== true) {
      const approved = await options.sessions.requestAppToolApproval(
        sessionId,
        `app-${randomUUID()}`,
        {
          toolName: 'mcp__wevir__simulator_control',
          display: {
            kind: 'unknown',
            mcpServer: 'wevir',
            summary: `Install and launch ${appPath} on ${device.name}`,
          },
          input: { action: 'launch', app_path: appPath, device: device.udid },
        },
        signal,
      );
      if (!approved)
        throw new AppToolError('The user denied installing this app. Nothing was installed.');
    }
    await service.simctl.install(device.udid, appPath);
    bundleId ??= await bundleIdOf(exec, appPath);
  }
  const pid = await service.simctl.launch(device.udid, bundleId as string, launchArgs, env);
  await service.agentAttach(sessionId, device.udid);
  return text(
    `Launched ${bundleId}${pid === undefined ? '' : ` (pid ${pid})`} on ${label(device)}.`,
  );
}

async function screenshot(
  service: SimulatorService,
  device: SimulatorDevice,
): Promise<AppToolResult> {
  const shot = await service.screenshot({ udid: device.udid, format: 'png', scale: 1 });
  const described = await service.describe(device.udid).catch(() => undefined);
  return {
    content: [
      { type: 'image', data: shot.data ?? '', mimeType: shot.mimeType },
      {
        type: 'text',
        text:
          `${label(device)}: ${shot.width}×${shot.height} points` +
          `${described === undefined ? '' : `, ${described.orientation}`}. Use these points for tap and swipe.`,
      },
    ],
  };
}

async function logs(
  service: SimulatorService,
  device: SimulatorDevice,
  args: Record<string, unknown>,
): Promise<AppToolResult> {
  const seconds = Math.min(
    LOGS_MAX_SECONDS,
    Math.max(1, Math.round(optionalNumber(args, 'seconds') ?? LOGS_DEFAULT_SECONDS)),
  );
  const bundleId = optionalString(args, 'bundle_id');
  let predicate: string | undefined;
  if (bundleId !== undefined) {
    if (!/^[A-Za-z0-9.-]+$/.test(bundleId))
      throw new AppToolError('bundle_id is not a bundle identifier.');
    const app = await service.simctl.appContainer(device.udid, bundleId).catch(() => undefined);
    const process = app === undefined ? undefined : basename(app, '.app').replace(/"/g, '');
    predicate =
      `subsystem BEGINSWITH "${bundleId}"` +
      (process === undefined ? '' : ` OR process == "${process}"`);
  }
  const output = await service.simctl.logs(device.udid, seconds, predicate);
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  const kept = lines.slice(-LOGS_MAX_LINES);
  const head = lines.length > kept.length ? `(last ${kept.length} of ${lines.length} lines)\n` : '';
  return text(
    kept.length === 0 ? `No log lines in the last ${seconds} s.` : head + kept.join('\n'),
  );
}

/** 把工具参数换成 `simulator.input` 的输入（形状再按协议的 schema 校验一次）。 */
function inputOf(action: Action, args: Record<string, unknown>): SimulatorInput {
  let input: unknown;
  switch (action) {
    case 'tap':
      input = {
        type: 'tap',
        x: requiredNumber(args, 'x'),
        y: requiredNumber(args, 'y'),
        ...(optionalNumber(args, 'duration') !== undefined && {
          duration: optionalNumber(args, 'duration'),
        }),
      };
      break;
    case 'swipe': {
      const from = { x: requiredNumber(args, 'from_x'), y: requiredNumber(args, 'from_y') };
      const to = { x: requiredNumber(args, 'to_x'), y: requiredNumber(args, 'to_y') };
      input = {
        type: 'touch',
        points: swipePoints(from, to, optionalNumber(args, 'duration') ?? 0.3),
      };
      break;
    }
    case 'touch_path': {
      const points = arrayArg(args, 'points').map((point) => ({
        x: requiredNumber(point, 'x'),
        y: requiredNumber(point, 'y'),
        dtMs: optionalNumber(point, 'dt_ms') ?? 16,
      }));
      input = { type: 'touch', points };
      break;
    }
    case 'touch2_path': {
      const points2 = arrayArg(args, 'points2').map((point) => ({
        x1: requiredNumber(point, 'x1'),
        y1: requiredNumber(point, 'y1'),
        x2: requiredNumber(point, 'x2'),
        y2: requiredNumber(point, 'y2'),
        dtMs: optionalNumber(point, 'dt_ms') ?? 16,
      }));
      input = { type: 'touch', points2 };
      break;
    }
    case 'text':
      input = { type: 'text', text: requiredString(args, 'text') };
      break;
    case 'press_key':
      input = {
        type: 'key',
        key: requiredString(args, 'key'),
        ...(args.count !== undefined && { count: args.count }),
      };
      break;
    case 'button':
      input = {
        type: 'button',
        name: requiredString(args, 'name'),
        ...(optionalNumber(args, 'duration') !== undefined && {
          duration: optionalNumber(args, 'duration'),
        }),
      };
      break;
    case 'rotate':
      input = { type: 'rotate', direction: requiredString(args, 'direction') };
      break;
    default:
      throw new AppToolError(`Unsupported action ${action}.`);
  }
  const parsed = SimulatorInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppToolError(
      `Invalid arguments (${issue?.path.join('.') ?? ''}): ${issue?.message ?? 'see the tool schema'}.`,
    );
  }
  return parsed.data;
}

/** 直线滑动：按 60 Hz 取样，至少两个点。 */
export function swipePoints(
  from: { x: number; y: number },
  to: { x: number; y: number },
  seconds: number,
): Array<{ x: number; y: number; dtMs: number }> {
  const duration = Math.min(5, Math.max(0.05, seconds));
  const steps = Math.max(2, Math.round(duration * 60));
  const dtMs = Math.round((duration * 1000) / steps);
  const points = [{ x: from.x, y: from.y, dtMs: 0 }];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push({
      x: Math.round((from.x + (to.x - from.x) * t) * 10) / 10,
      y: Math.round((from.y + (to.y - from.y) * t) * 10) / 10,
      dtMs,
    });
  }
  return points;
}

// ── 设备与项目 ──────────────────────────────────────────────────────────

/**
 * agent 要操作的设备：给了名字或 UDID 时按它找（同名的优先已启动的）；没给时用这个会话 attach 的，再否则第一个已启动的。
 * `boot`、`attach`、`launch` 可以指没启动的设备，其余动作要已启动的。
 */
export async function resolveDevice(
  service: SimulatorService,
  sessionId: SessionId,
  wanted: string | undefined,
  action: Action | 'build',
): Promise<SimulatorDevice> {
  const { devices } = await service.list();
  const usable = devices.filter((device) => device.available);
  let device: SimulatorDevice | undefined;
  if (wanted !== undefined) {
    const lower = wanted.toLowerCase();
    device =
      devices.find((candidate) => candidate.udid.toLowerCase() === lower) ??
      usable.find(
        (candidate) => candidate.name.toLowerCase() === lower && candidate.state === 'booted',
      ) ??
      usable.find((candidate) => candidate.name.toLowerCase() === lower);
    if (device === undefined) {
      throw new SimulatorError(
        'sim_not_found',
        `No simulator named ${wanted}. Available: ${names(usable)}.`,
      );
    }
  } else {
    const attached = service.agentDevice(sessionId);
    device =
      devices.find((candidate) => candidate.udid === attached) ??
      devices.find((candidate) => candidate.state === 'booted');
    if (device === undefined) {
      throw new SimulatorError(
        'sim_not_booted',
        `No simulator is booted. Pass device with one of: ${names(usable)}.`,
      );
    }
  }
  const mayBoot =
    action === 'boot' || action === 'attach' || action === 'launch' || action === 'build';
  if (device.state !== 'booted' && !mayBoot) {
    throw new SimulatorError(
      'sim_not_booted',
      `${label(device)} is not booted. Use action boot or attach first.`,
    );
  }
  return device;
}

type Container = { kind: 'workspace' | 'project' | 'package'; path: string };

/** 要构建的工作区、工程或 SwiftPM 包。 */
async function findContainer(cwd: string, args: Record<string, unknown>): Promise<Container> {
  const workspace = optionalString(args, 'workspace');
  const project = optionalString(args, 'project');
  if (workspace !== undefined && project !== undefined) {
    throw new AppToolError('Pass workspace or project, not both.');
  }
  if (workspace !== undefined) return { kind: 'workspace', path: resolve(cwd, workspace) };
  if (project !== undefined) return { kind: 'project', path: resolve(cwd, project) };
  const entries = await readdir(cwd).catch(() => [] as string[]);
  const workspaces = entries.filter((name) => name.endsWith('.xcworkspace'));
  if (workspaces.length === 1)
    return { kind: 'workspace', path: join(cwd, workspaces[0] as string) };
  const projects = entries.filter((name) => name.endsWith('.xcodeproj'));
  if (workspaces.length === 0 && projects.length === 1) {
    return { kind: 'project', path: join(cwd, projects[0] as string) };
  }
  if (workspaces.length + projects.length > 1) {
    throw new AppToolError(
      `Several Xcode workspaces or projects here; pass workspace or project: ${[...workspaces, ...projects].join(', ')}.`,
    );
  }
  if (entries.includes('Package.swift')) return { kind: 'package', path: cwd };
  throw new AppToolError(
    "No .xcworkspace, .xcodeproj or Package.swift in this session's folder; pass workspace or project.",
  );
}

async function pickScheme(
  exec: NonNullable<SimulatorToolsOptions['exec']>,
  container: Container,
  cwd: string,
): Promise<string> {
  const args = [
    '-list',
    '-json',
    ...(container.kind === 'package' ? [] : [`-${container.kind}`, container.path]),
  ];
  const output = await exec(
    'xcodebuild',
    args,
    container.kind === 'package' ? container.path : cwd,
  );
  let schemes: string[] = [];
  try {
    const json = JSON.parse(output.slice(output.indexOf('{'))) as {
      project?: { schemes?: string[] };
      workspace?: { schemes?: string[] };
    };
    schemes = json.workspace?.schemes ?? json.project?.schemes ?? [];
  } catch {
    throw new AppToolError('xcodebuild -list returned no scheme list; pass scheme.');
  }
  if (schemes.length === 1) return schemes[0] as string;
  if (schemes.length === 0) throw new AppToolError('No schemes found; pass scheme.');
  throw new AppToolError(`Pass scheme, one of: ${schemes.join(', ')}.`);
}

async function findApp(productsDir: string, scheme: string): Promise<string> {
  const apps = (await readdir(productsDir).catch(() => [] as string[])).filter(
    (name) => name.endsWith('.app') && !name.endsWith('-Runner.app'),
  );
  const app =
    apps.find((name) => name === `${scheme}.app`) ?? (apps.length === 1 ? apps[0] : undefined);
  if (app === undefined) {
    throw new AppToolError(
      apps.length === 0
        ? `The build succeeded but no .app is in ${productsDir}.`
        : `Several apps in ${productsDir}: ${apps.join(', ')}; pass one as app_path to launch.`,
    );
  }
  return join(productsDir, app);
}

async function bundleIdOf(
  exec: NonNullable<SimulatorToolsOptions['exec']>,
  app: string,
): Promise<string> {
  const id = (
    await exec(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Info.plist')],
      app,
    )
  ).trim();
  if (id === '') throw new AppToolError(`No CFBundleIdentifier in ${app}/Info.plist.`);
  return id;
}

function execText(file: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      { cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolvePromise(stdout);
        else
          reject(
            new AppToolError(
              `${basename(file)} failed: ${String(stderr).trim().split('\n').slice(-3).join(' ') || error.message}`,
            ),
          );
      },
    );
  });
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function listResult(
  result: { devices: SimulatorDevice[] },
  attached: string | undefined,
): AppToolResult {
  if (result.devices.length === 0)
    return text('No iOS simulators. Create one in Xcode or the simulator pane.');
  const lines = result.devices.map(
    (device) =>
      `- ${device.name} (${device.udid}) iOS ${device.osVersion || '?'}, ${device.available ? device.state : 'unavailable'}` +
      (device.udid === attached ? ', attached here' : ''),
  );
  return text(lines.join('\n'));
}

function label(device: SimulatorDevice): string {
  return `${device.name} (${device.udid}${device.osVersion === '' ? '' : `, iOS ${device.osVersion}`})`;
}

function names(devices: readonly SimulatorDevice[]): string {
  const unique = [...new Set(devices.map((device) => device.name))];
  return unique.length === 0 ? 'none' : unique.slice(0, 20).join(', ');
}

/** 单引号包起来给 shell。 */
/**
 * helper 的无障碍树（`{root, count, truncated}`）写成一行一个元素、按层缩进：角色、名字、`#标识`、引用、点坐标与尺寸、值与状态，
 * 比 JSON 省一大半 token。形状不认识时原样给 JSON。
 */
export function formatAxTree(tree: Record<string, unknown>): string {
  const root = tree.root;
  if (root === null || typeof root !== 'object') return JSON.stringify(tree);
  const lines: string[] = [];
  const walk = (node: Record<string, unknown>, depth: number) => {
    const parts = [typeof node.role === 'string' ? node.role : 'Element'];
    if (typeof node.label === 'string' && node.label !== '') parts.push(JSON.stringify(node.label));
    if (typeof node.identifier === 'string' && node.identifier !== '') {
      parts.push(`#${node.identifier}`);
    }
    if (typeof node.id === 'string') parts.push(node.id);
    const frame = node.frame as Record<string, unknown> | undefined;
    if (
      typeof frame?.x === 'number' &&
      typeof frame.y === 'number' &&
      typeof frame.width === 'number' &&
      typeof frame.height === 'number'
    ) {
      const r = Math.round;
      parts.push(`(${r(frame.x)},${r(frame.y)} ${r(frame.width)}×${r(frame.height)})`);
    }
    if (node.value !== undefined && node.value !== null && node.value !== '') {
      parts.push(`value=${JSON.stringify(node.value)}`);
    }
    if (node.enabled === false) parts.push('disabled');
    if (node.focused === true) parts.push('focused');
    lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) {
      if (child !== null && typeof child === 'object')
        walk(child as Record<string, unknown>, depth + 1);
    }
  };
  walk(root as Record<string, unknown>, 0);
  const count = typeof tree.count === 'number' ? tree.count : lines.length;
  lines.push(
    `${count} elements${tree.truncated === true ? ' (truncated: describe_ui with x and y for one area)' : ''}. ` +
      'Frames are (x,y width×height) in points; tap the center.',
  );
  return lines.join('\n');
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=,@%+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function text(value: string): AppToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function errorResult(code: string, message: string): AppToolResult {
  return { content: [{ type: 'text', text: `${code}: ${message}` }], isError: true };
}

function disabledResult(): AppToolResult {
  return errorResult(
    'sim_disabled',
    'The iOS Simulator tools are turned off. The user can turn them on in Wevir Settings.',
  );
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new AppToolError(`${key} must be a string.`);
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new AppToolError(`${key} is required.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppToolError(`${key} must be a number.`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, key: string): number {
  const value = optionalNumber(args, key);
  if (value === undefined) throw new AppToolError(`${key} is required.`);
  return value;
}

function arrayArg(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppToolError(`${key} must be a non-empty array.`);
  }
  return value.map((item) => {
    if (item === null || typeof item !== 'object')
      throw new AppToolError(`${key} items must be objects.`);
    return item as Record<string, unknown>;
  });
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppToolError(`${key} must be an array of strings.`);
  }
  return value as string[];
}

function stringRecord(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== 'string')
  ) {
    throw new AppToolError(`${key} must be an object of strings.`);
  }
  return value as Record<string, string>;
}
