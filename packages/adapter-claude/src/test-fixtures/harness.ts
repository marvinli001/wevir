// 测试共用：假的 SDK 上的适配器，账号直接当作已装、已登录（不找可执行文件、不跑 `claude --version`）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccounts } from '../account.js';
import { ClaudeAdapter } from '../claude-adapter.js';
import { FakeClaudeSdk, type FakeSdkOptions } from './fake-sdk.js';

export const FAKE_CLAUDE = '/fake/bin/claude';
export const FAKE_VERSION = '2.1.287';

export function fakeAccounts(sdk: FakeClaudeSdk, workDir: string): ClaudeAccounts {
  return new ClaudeAccounts({
    sdk,
    workDir,
    env: { PATH: '/usr/bin', HOME: '/home/test' },
    findExecutable: () => FAKE_CLAUDE,
    probeVersion: async () => ({ ok: true, version: FAKE_VERSION }),
  });
}

export interface FakeHarness {
  sdk: FakeClaudeSdk;
  adapter: ClaudeAdapter;
  home: string;
}

/** 新建一个跑在假 SDK 上的适配器；`cleanup` 删掉临时数据目录。 */
export function newFakeAdapter(
  options: FakeSdkOptions & { cancelTimeoutMs?: number } = {},
): FakeHarness {
  const home = mkdtempSync(join(tmpdir(), 'wevir-claude-test-'));
  const sdk = new FakeClaudeSdk(options);
  const adapter = new ClaudeAdapter({
    home,
    sdk,
    accounts: fakeAccounts(sdk, join(home, 'engines', 'claude')),
    env: { PATH: '/usr/bin', HOME: '/home/test' },
    ...(options.cancelTimeoutMs !== undefined && { cancelTimeoutMs: options.cancelTimeoutMs }),
  });
  return { sdk, adapter, home };
}

export function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true });
}
