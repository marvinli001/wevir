// `xcrun simctl`（0.122.0）：模拟器的生命周期与应用操作由 Host 直接起进程做，私有接口的事才交给 helper。命令的输出不进日志。

import { execFile } from 'node:child_process';
import type {
  SimulatorDevice,
  SimulatorDeviceType,
  SimulatorFamily,
  SimulatorRuntime,
  SimulatorState,
} from '@wevir/protocol';
import { SimulatorError } from './errors.js';

/** 一条 simctl 命令的默认上限。 */
export const SIMCTL_TIMEOUT_MS = 60_000;

export interface SimctlRunOptions {
  timeoutMs?: number;
  /** 写进 stdin 的内容（`pbcopy`）。 */
  input?: string;
  /** 额外的环境变量（`launch` 的 `SIMCTL_CHILD_*`）。 */
  env?: Record<string, string>;
}

/** 跑 `xcrun simctl <args>`，失败时抛 `SimulatorError`（`sim_simctl_failed`，带 stderr 的最后几行）。 */
export type SimctlRunner = (
  args: readonly string[],
  options?: SimctlRunOptions,
) => Promise<{ stdout: string; stderr: string }>;

export const runSimctl: SimctlRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'xcrun',
      ['simctl', ...args],
      {
        timeout: options.timeoutMs ?? SIMCTL_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        const detail = String(stderr).trim().split('\n').slice(-3).join(' ').slice(0, 500);
        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(
          new SimulatorError(
            timedOut ? 'sim_timeout' : 'sim_simctl_failed',
            `simctl ${args[0] ?? ''} failed${detail === '' ? `: ${error.message}` : `: ${detail}`}`,
          ),
        );
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

/** `simctl list -j` 里用到的部分。 */
interface ListJson {
  devices?: Record<string, RawDevice[]>;
  devicetypes?: Array<{ identifier?: string; name?: string; productFamily?: string }>;
  runtimes?: Array<{
    identifier?: string;
    name?: string;
    platform?: string;
    version?: string;
    isAvailable?: boolean;
  }>;
}

interface RawDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

export interface SimctlList {
  /** 不含 `attachedBy`（由 service 补上）。 */
  devices: Omit<SimulatorDevice, 'attachedBy'>[];
  deviceTypes: SimulatorDeviceType[];
  runtimes: SimulatorRuntime[];
}

const STATES: Record<string, SimulatorState> = {
  Booted: 'booted',
  Booting: 'booting',
  'Shutting Down': 'shuttingDown',
};

/** 设备类型标识或产品系列 → 系列。 */
export function simulatorFamily(text: string | undefined): SimulatorFamily {
  const value = (text ?? '').toLowerCase();
  if (value.includes('iphone')) return 'iphone';
  if (value.includes('ipad')) return 'ipad';
  if (value.includes('watch')) return 'watch';
  if (value.includes('apple-tv') || value.includes('appletv') || value === 'apple tv') return 'tv';
  if (value.includes('vision')) return 'vision';
  return 'other';
}

/** 解析 `simctl list -j devices devicetypes runtimes`：只留 iOS 的运行时与设备；已启动的设备在前，其余按名字。 */
export function parseSimctlList(stdout: string): SimctlList {
  let json: ListJson;
  try {
    json = JSON.parse(stdout) as ListJson;
  } catch {
    throw new SimulatorError('sim_simctl_failed', 'simctl list returned invalid JSON');
  }
  const runtimes: SimulatorRuntime[] = (json.runtimes ?? [])
    .filter((runtime) => runtime.platform === 'iOS' && typeof runtime.identifier === 'string')
    .map((runtime) => ({
      id: runtime.identifier as string,
      name: runtime.name ?? '',
      platform: 'ios',
      version: runtime.version ?? '',
      available: runtime.isAvailable === true,
    }));
  const versions = new Map(runtimes.map((runtime) => [runtime.id, runtime.version]));
  const deviceTypes: SimulatorDeviceType[] = (json.devicetypes ?? [])
    .filter(
      (type) =>
        typeof type.identifier === 'string' &&
        (type.productFamily === 'iPhone' || type.productFamily === 'iPad'),
    )
    .map((type) => ({
      id: type.identifier as string,
      name: type.name ?? '',
      family: simulatorFamily(type.productFamily),
    }));
  const devices: SimctlList['devices'] = [];
  for (const [runtime, list] of Object.entries(json.devices ?? {})) {
    if (!/\.SimRuntime\.iOS-/.test(runtime)) continue;
    for (const raw of list) {
      if (typeof raw.udid !== 'string' || raw.udid === '') continue;
      devices.push({
        udid: raw.udid,
        name: raw.name ?? '',
        platform: 'ios',
        runtime,
        osVersion: versions.get(runtime) ?? '',
        family: simulatorFamily(raw.deviceTypeIdentifier),
        ...(raw.deviceTypeIdentifier !== undefined && { deviceTypeId: raw.deviceTypeIdentifier }),
        state: STATES[raw.state ?? ''] ?? 'shutdown',
        available: raw.isAvailable === true,
      });
    }
  }
  devices.sort(
    (a, b) =>
      Number(b.state === 'booted') - Number(a.state === 'booted') || a.name.localeCompare(b.name),
  );
  return { devices, deviceTypes, runtimes };
}

/** simctl 的几个操作，都经 `run`（测试换成假的）。 */
export class Simctl {
  readonly #run: SimctlRunner;

  constructor(run: SimctlRunner = runSimctl) {
    this.#run = run;
  }

  async list(): Promise<SimctlList> {
    const { stdout } = await this.#run(['list', '-j', 'devices', 'devicetypes', 'runtimes']);
    return parseSimctlList(stdout);
  }

  /** 启动并等到能用（`bootstatus -b`）。已经启动的不算失败。 */
  async boot(udid: string): Promise<void> {
    try {
      await this.#run(['boot', udid]);
    } catch (error) {
      if (!(error instanceof SimulatorError) || !/current state: Booted/i.test(error.message)) {
        throw error;
      }
    }
    await this.#run(['bootstatus', udid, '-b'], { timeoutMs: 180_000 });
  }

  async shutdown(udid: string): Promise<void> {
    try {
      await this.#run(['shutdown', udid]);
    } catch (error) {
      if (!(error instanceof SimulatorError) || !/current state: Shutdown/i.test(error.message)) {
        throw error;
      }
    }
  }

  /** 新建设备，返回 UDID。 */
  async create(name: string, deviceTypeId: string, runtimeId: string): Promise<string> {
    const { stdout } = await this.#run(['create', name, deviceTypeId, runtimeId]);
    return stdout.trim();
  }

  async install(udid: string, appPath: string): Promise<void> {
    await this.#run(['install', udid, appPath], { timeoutMs: 180_000 });
  }

  /** 启动应用（先结束已在跑的），返回进程号。`env` 经 `SIMCTL_CHILD_` 前缀交给应用。 */
  async launch(
    udid: string,
    bundleId: string,
    args: readonly string[] = [],
    env: Record<string, string> = {},
  ): Promise<number | undefined> {
    const childEnv = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [`SIMCTL_CHILD_${key}`, value]),
    );
    const { stdout } = await this.#run(
      ['launch', '--terminate-running-process', udid, bundleId, ...args],
      { env: childEnv },
    );
    const pid = /:\s*(\d+)\s*$/.exec(stdout.trim())?.[1];
    return pid === undefined ? undefined : Number(pid);
  }

  async terminate(udid: string, bundleId: string): Promise<void> {
    await this.#run(['terminate', udid, bundleId]);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await this.#run(['openurl', udid, url]);
  }

  async appearance(udid: string, appearance: 'light' | 'dark'): Promise<void> {
    await this.#run(['ui', udid, 'appearance', appearance]);
  }

  /** `clean`：9:41、满格信号与 Wi-Fi、电量满；`live`：清掉覆盖。 */
  async statusBar(udid: string, mode: 'live' | 'clean'): Promise<void> {
    if (mode === 'live') {
      await this.#run(['status_bar', udid, 'clear']);
      return;
    }
    await this.#run([
      'status_bar',
      udid,
      'override',
      '--time',
      '9:41',
      '--dataNetwork',
      'wifi',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
    ]);
  }

  async pasteboardGet(udid: string): Promise<string> {
    return (await this.#run(['pbpaste', udid])).stdout;
  }

  async pasteboardSet(udid: string, text: string): Promise<void> {
    await this.#run(['pbcopy', udid], { input: text });
  }

  /** 应用的 .app 目录（`get_app_container … app`）；没装时抛错。 */
  async appContainer(udid: string, bundleId: string): Promise<string> {
    return (await this.#run(['get_app_container', udid, bundleId, 'app'])).stdout.trim();
  }

  /** 设备里最近 `seconds` 秒的系统日志（`log show`），`predicate` 是 `log` 的过滤式。 */
  async logs(udid: string, seconds: number, predicate: string | undefined): Promise<string> {
    const args = ['spawn', udid, 'log', 'show', '--last', `${seconds}s`, '--style', 'compact'];
    if (predicate !== undefined) args.push('--predicate', predicate);
    return (await this.#run(args, { timeoutMs: 60_000 })).stdout;
  }
}
