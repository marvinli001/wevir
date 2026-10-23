// 只给测试：假 helper 的可执行包装、假 simctl 与记录发出内容的假 WebSocket。

import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIMULATOR_FRAME_HEADER_BYTES } from '@wevir/protocol';
import type { SimulatorStreamSocket } from './service.js';
import type { SimctlRunner } from './simctl.js';

export const BOOTED = '8A4F2C1E-3B5D-4E6F-9A7B-1C2D3E4F5A6B';
export const SHUT = '1B2C3D4E-5F60-4718-8293-A4B5C6D7E8F9';

/** 在 `dir` 里写一个跑假 helper 的可执行脚本，返回路径（helper 要的是可执行文件）。 */
export function fakeHelperBin(dir: string, env: Record<string, string> = {}): string {
  const script = fileURLToPath(new URL('../test-fixtures/fake-ios-simulator.mjs', import.meta.url));
  const bin = join(dir, 'wevir-ios-simulator');
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}='${value}'\n`)
    .join('');
  writeFileSync(bin, `#!/bin/sh\n${exports}exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** 假 simctl：两台 iOS 设备（一台已启动），`boot` / `shutdown` 改状态，记下每次调用。 */
export function fakeSimctl(): { run: SimctlRunner; calls: string[][]; state: Map<string, string> } {
  const calls: string[][] = [];
  const state = new Map([
    [BOOTED, 'Booted'],
    [SHUT, 'Shutdown'],
  ]);
  const run: SimctlRunner = async (args) => {
    calls.push([...args]);
    switch (args[0]) {
      case 'list':
        return {
          stdout: JSON.stringify({
            runtimes: [
              {
                identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
                name: 'iOS 26.5',
                platform: 'iOS',
                version: '26.5',
                isAvailable: true,
              },
            ],
            devicetypes: [
              {
                identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                name: 'iPhone 17 Pro',
                productFamily: 'iPhone',
              },
            ],
            devices: {
              'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
                {
                  udid: SHUT,
                  name: 'iPad Air',
                  state: state.get(SHUT),
                  isAvailable: true,
                  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air',
                },
                {
                  udid: BOOTED,
                  name: 'iPhone 17 Pro',
                  state: state.get(BOOTED),
                  isAvailable: true,
                  deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
                },
              ],
              'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [
                { udid: 'WATCH', name: 'Apple Watch', state: 'Shutdown', isAvailable: true },
              ],
            },
          }),
          stderr: '',
        };
      case 'boot':
        state.set(args[1] as string, 'Booted');
        return { stdout: '', stderr: '' };
      case 'shutdown':
        state.set(args[1] as string, 'Shutdown');
        return { stdout: '', stderr: '' };
      case 'launch':
        return { stdout: `${args.at(-1)}: 4242\n`, stderr: '' };
      case 'pbpaste':
        return { stdout: 'from device', stderr: '' };
      default:
        return { stdout: '', stderr: '' };
    }
  };
  return { run, calls, state };
}

/** 记下发出的帧的假 WebSocket；`bufferedAmount` 可以改。 */
export class FakeSocket implements SimulatorStreamSocket {
  bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  closed: { code?: number; reason?: string } | undefined;
  #onClose: (() => void) | undefined;

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  close(code?: number, reason?: string): void {
    if (this.closed !== undefined) return;
    this.closed = { ...(code !== undefined && { code }), ...(reason !== undefined && { reason }) };
    this.#onClose?.();
  }

  once(_event: 'close', listener: () => void): this {
    this.#onClose = listener;
    return this;
  }

  /** 发出的帧：`kind` 与 payload 文本。 */
  frames(): Array<{ kind: number; text: string }> {
    return this.sent.map((frame) => ({
      kind: frame.readUInt8(0),
      text: frame.subarray(SIMULATOR_FRAME_HEADER_BYTES).toString('utf8'),
    }));
  }
}

/** 等到条件成立（最多 `ms`）。 */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
