// 后台进程与用量统计的命令对着进程内的 echo Host（echo 不起后台进程，这里只覆盖空列表、错误与输出格式）。

import { join } from 'node:path';
import type { RunningHost } from '@wevir/host';
import { afterEach, describe, expect, it } from 'vitest';
import { run, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});

async function setup() {
  const home = join(tempDir(), 'home');
  host = await startEchoHost(home);
  return { home };
}

describe('wevir process', () => {
  it('空列表、--json、不存在的进程与认不出的信号', async () => {
    const { home } = await setup();
    expect((await run(['process', 'list'], { home })).out).toContain('暂无进程');
    expect(JSON.parse((await run(['process', 'list', '--json'], { home })).out)).toEqual([]);
    const output = await run(['process', 'output', 'p1'], { home });
    expect(output.code).toBe(1);
    const signal = await run(['process', 'stop', 'p1', '--signal', 'HUP'], { home });
    expect(signal.code).toBe(2);
    expect(signal.err).toContain('未知信号：HUP');
  });
});

describe('wevir usage', () => {
  it('没有请求时说明；--json 是 Host 的汇总；--days 校验', async () => {
    const { home } = await setup();
    const summary = await run(['usage'], { home });
    expect(summary.code, summary.err).toBe(0);
    expect(summary.out).toContain('最近 7 天');
    expect(summary.out).toContain('暂无请求');
    const json = JSON.parse((await run(['usage', '--days', '30', '--json'], { home })).out);
    expect(json.totals.requests).toBe(0);
    expect((await run(['usage', '--days', '0'], { home })).code).toBe(2);
  });
});
