// 测试共用：假的 opencode（fake-opencode.ts）上的适配器，可执行文件当作已装（不找 `opencode`、不跑 `--version`、不起进程）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from '../opencode-adapter.js';
import { FAKE_OPENCODE_VERSION, FakeOpenCode } from './fake-opencode.js';

export const FAKE_OPENCODE = '/fake/bin/opencode';

export interface FakeHarness {
  fake: FakeOpenCode;
  adapter: OpenCodeAdapter;
  home: string;
  cleanup(): Promise<void>;
}

export function fakeAdapterOptions(
  fake: FakeOpenCode,
  home: string,
  extra: Partial<OpenCodeAdapterOptions> = {},
): OpenCodeAdapterOptions {
  return {
    home,
    env: { PATH: '/usr/bin', HOME: home },
    sdk: async () => fake,
    findExecutable: () => FAKE_OPENCODE,
    probeVersion: async () => ({ ok: true, version: FAKE_OPENCODE_VERSION }),
    startServer: fake.start,
    idleTtlMs: 50,
    cancelTimeoutMs: 2_000,
    ...extra,
  };
}

export function fakeHarness(extra: Partial<OpenCodeAdapterOptions> = {}): FakeHarness {
  const fake = new FakeOpenCode();
  const home = mkdtempSync(join(tmpdir(), 'wevir-opencode-test-'));
  const adapter = new OpenCodeAdapter(fakeAdapterOptions(fake, home, extra));
  return {
    fake,
    adapter,
    home,
    cleanup: async () => {
      await adapter.dispose();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
