// 记忆管理（0.57.0）：经 RPC 对着真实的 Host（echo 引擎）——两个客户端看到一致的结果、`memory.changed`、A / B 项目不串、
// 旧格式与坏文件、冲突、停用与开关在重启后还在。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, MethodSchemas } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

async function start(home: string) {
  const host = await startHost({
    home,
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
  running.push(host);
  return host;
}

async function connect(host: RunningHost) {
  const client = await TestRpcClient.connect(host.url);
  clients.push(client);
  const info = JSON.parse(readFileSync(join(host.home, 'run', 'host.json'), 'utf8'));
  const hello = await client.hello(info.token);
  return { client, features: hello.result?.features as Record<string, boolean> };
}

const noteFile = (name: string, description: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\ntype: project\n${extra}---\n\nBody of ${name}.\n`;

function seed(home: string, dir: string, files: Record<string, string>) {
  const path = join(home, 'memory', dir);
  mkdirSync(path, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
}

async function rpcError(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: number }).code;
  }
}

describe('memory.*（Host + 两个客户端）', () => {
  it('列表、读、改、冲突、停用、删除；另一个客户端收到 memory.changed；A / B 不串；重启后都还在', async () => {
    const root = tempDir();
    const home = join(root, 'home');
    const host = await start(home);
    const first = await connect(host);
    const second = await connect(host);
    expect(first.features.memory).toBe(true);
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const wsA = (await first.client.request('workspace.add', { rootPath: a })).workspace.id;
    const wsB = (await first.client.request('workspace.add', { rootPath: b })).workspace.id;
    seed(home, 'global', {
      'reply-language.md': noteFile(
        'reply-language',
        'Answer in Chinese',
        'updated: 2026-10-01T00:00:00.000Z\n',
      ),
    });
    seed(home, join('projects', wsA), {
      'invoice-cents.md': noteFile(
        'invoice-cents',
        'Money in cents',
        'updated: 2026-10-02T00:00:00.000Z\n',
      ),
      'old-note.md': noteFile('old-note', 'Written before updated existed'),
      'broken.md': 'not a note',
    });
    seed(home, join('projects', wsB), { 'b-only.md': noteFile('b-only', 'Only for B') });

    const listA = await first.client.request('memory.list', { workspaceId: wsA });
    expect(MethodSchemas['memory.list'].result.safeParse(listA).success).toBe(true);
    expect(
      listA.notes.map((note: { scope: string; name: string }) => `${note.scope}/${note.name}`),
    ).toEqual(['project/invoice-cents', 'global/reply-language', 'project/old-note']);
    expect(listA.unreadable).toEqual([{ scope: 'project', name: 'broken' }]);
    expect(JSON.stringify(listA)).not.toContain(home);
    const listB = await second.client.request('memory.list', { workspaceId: wsB });
    expect(listB.notes.map((note: { name: string }) => note.name)).toEqual([
      'reply-language',
      'b-only',
    ]);
    expect((await first.client.request('memory.list', {})).notes).toHaveLength(1);

    // 第二个客户端在看 A：第一个改了之后收到通知，重读到一样的结果。
    await second.client.request('memory.list', { workspaceId: wsA });
    const { note } = await first.client.request('memory.read', {
      scope: 'project',
      workspaceId: wsA,
      name: 'invoice-cents',
    });
    expect(note).toMatchObject({ content: 'Body of invoice-cents.', enabled: true });
    const updated = await first.client.request('memory.update', {
      scope: 'project',
      workspaceId: wsA,
      name: 'invoice-cents',
      revision: note.revision,
      description: 'Money is stored in integer cents',
    });
    expect(updated.conflict).toBeUndefined();
    // 用户编辑记成用户（0.58.0）；旧笔记没有首次来源，不补造。
    expect(updated.note.lastEdit).toEqual({ by: 'user', at: expect.any(String) });
    expect(updated.note.origin).toBeUndefined();
    await second.client.until(
      () =>
        second.client
          .notifications('memory.changed')
          .find((change) => change.name === 'invoice-cents'),
      'memory.changed',
    );
    expect(second.client.notifications('memory.changed')[0]).toEqual({
      scope: 'project',
      workspaceId: wsA,
      name: 'invoice-cents',
    });
    const seen = await second.client.request('memory.list', { workspaceId: wsA });
    expect(seen.notes.find((entry: { name: string }) => entry.name === 'invoice-cents')).toEqual(
      expect.objectContaining({
        description: 'Money is stored in integer cents',
        revision: updated.note.revision,
      }),
    );

    // 第二个客户端拿着旧版本保存：冲突，不写。
    const stale = await second.client.request('memory.update', {
      scope: 'project',
      workspaceId: wsA,
      name: 'invoice-cents',
      revision: note.revision,
      content: 'overwrite',
    });
    expect(stale).toEqual({ note: updated.note, conflict: true });

    // 客户端给不了来源：参数里夹带的来源字段不认，照样记成用户编辑。
    const forged = await second.client.request('memory.update', {
      scope: 'project',
      workspaceId: wsA,
      name: 'invoice-cents',
      revision: updated.note.revision,
      content: 'Edited again.',
      origin: { by: 'agent', at: '2026-10-01T00:00:00.000Z', sessionId: 'ses_forged' },
      lastEdit: { by: 'agent', at: '2026-10-01T00:00:00.000Z', sessionId: 'ses_forged' },
    } as never);
    expect(forged.note.lastEdit).toEqual({ by: 'user', at: expect.any(String) });
    expect(forged.note.origin).toBeUndefined();
    expect(
      readFileSync(join(home, 'memory', 'projects', wsA, 'invoice-cents.md'), 'utf8'),
    ).not.toContain('ses_forged');
    updated.note = forged.note;

    const off = await second.client.request('memory.setEnabled', {
      scope: 'global',
      name: 'reply-language',
      enabled: false,
    });
    expect(off.note.enabled).toBe(false);
    expect(
      await second.client.request('memory.delete', {
        scope: 'project',
        workspaceId: wsA,
        name: 'broken',
      }),
    ).toEqual({});

    expect(
      await rpcError(
        first.client.request('memory.read', {
          scope: 'project',
          workspaceId: wsA,
          name: 'missing',
        }),
      ),
    ).toBe(ErrorCode.MEMORY_NOT_FOUND);
    expect(
      await rpcError(
        first.client.request('memory.read', { scope: 'project', name: 'invoice-cents' }),
      ),
    ).toBe(ErrorCode.INVALID_PARAMS);
    expect(
      await rpcError(
        first.client.request('memory.list', { workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' }),
      ),
    ).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
    expect(
      await rpcError(
        first.client.request('memory.update', {
          scope: 'project',
          workspaceId: wsA,
          name: 'invoice-cents',
          revision: updated.note.revision,
          description: 'x'.repeat(201),
        }),
      ),
    ).toBe(ErrorCode.INVALID_PARAMS);

    const settings = await first.client.request('settings.update', {
      settings: { autoMemory: false },
    });
    expect(settings.settings.autoMemory).toBe(false);

    // 重启：停用、修改与开关都还在。
    for (const client of clients.splice(0)) client.ws.terminate();
    await running.splice(0)[0]?.shutdown();
    const again = await connect(await start(home));
    const after = await again.client.request('memory.list', { workspaceId: wsA });
    expect(after.unreadable).toEqual([]);
    expect(after.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'reply-language', enabled: false }),
        expect.objectContaining({
          name: 'invoice-cents',
          description: 'Money is stored in integer cents',
          revision: updated.note.revision,
        }),
      ]),
    );
    expect((await again.client.request('settings.get', {})).settings.autoMemory).toBe(false);
  });
});
