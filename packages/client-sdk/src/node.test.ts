import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostUnavailableError } from './errors.js';
import { connectLocalHost, hostRuntimeFilePath, readHostEndpoint } from './node.js';
import { FakeHost, identity, useTempDir } from './test-utils.js';

const tempDir = useTempDir();

function writeRuntimeFile(home: string, text: string): void {
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(hostRuntimeFilePath(home), text);
}

async function reason(home: string): Promise<string | undefined> {
  const error = await readHostEndpoint(home).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HostUnavailableError);
  return (error as HostUnavailableError).reason;
}

describe('readHostEndpoint', () => {
  it('只取 host.json 里的 url 与令牌', async () => {
    const home = tempDir();
    writeRuntimeFile(
      home,
      JSON.stringify({
        pid: 1,
        startedAt: '2026-10-13T00:00:00.000Z',
        protocolVersion: '0.3.0',
        hostVersion: '0.0.0',
        url: 'ws://127.0.0.1:50123/',
        token: 'tok',
      }),
    );
    expect(await readHostEndpoint(home)).toEqual({ url: 'ws://127.0.0.1:50123/', token: 'tok' });
  });

  it('没有文件：not_running；占位（空文件或没有 url）：starting；内容不对：invalid_runtime_file', async () => {
    const home = tempDir();
    expect(await reason(home)).toBe('not_running');
    writeRuntimeFile(home, '');
    expect(await reason(home)).toBe('starting');
    writeRuntimeFile(
      home,
      JSON.stringify({ pid: 1, startedAt: 'x', protocolVersion: '0.3.0', hostVersion: '0' }),
    );
    expect(await reason(home)).toBe('starting');
    writeRuntimeFile(home, '{not json');
    expect(await reason(home)).toBe('invalid_runtime_file');
    writeRuntimeFile(home, JSON.stringify({ url: 'ws://127.0.0.1:1/' }));
    expect(await reason(home)).toBe('invalid_runtime_file');
  });

  it('connectLocalHost：Host 没在运行时首次连接立即失败，不回退到任何默认端口', async () => {
    const host = new FakeHost();
    const error = await connectLocalHost({
      home: tempDir(),
      identity,
      transport: host.transport,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostUnavailableError);
    expect(host.sockets).toHaveLength(0);
  });
});
