import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { HostError } from '../errors.js';
import { useTempDir } from '../test-utils.js';
import { PreviewStore } from './store.js';

const tempDir = useTempDir();
const WS = 'ws_A' as WorkspaceId;

describe('PreviewStore', () => {
  it('新建、替换、改名、删除，写进 0600 的文件，重开后读得回', async () => {
    const dir = tempDir();
    const store = new PreviewStore({ dir });
    await store.save(
      WS,
      { name: 'web', command: 'pnpm run dev', cwd: './apps/web/' },
      { addedBy: 'user' },
    );
    await store.save(
      WS,
      { name: 'api', command: 'pnpm run api', port: 8787 },
      { addedBy: 'agent' },
    );
    const replaced = await store.save(
      WS,
      { name: 'web', command: 'pnpm run dev -- --port 5174', cwd: 'apps/web', port: 5174 },
      { addedBy: 'user' },
    );
    expect(
      replaced.map((config) => [config.name, config.cwd, config.port, config.addedBy]),
    ).toEqual([
      ['web', 'apps/web', 5174, 'user'],
      ['api', '', 8787, 'agent'],
    ]);
    const renamed = await store.save(
      WS,
      { name: 'site', command: 'pnpm run dev', cwd: 'apps/web' },
      { previous: 'web', addedBy: 'user' },
    );
    expect(renamed.map((config) => config.name)).toEqual(['site', 'api']);
    expect(renamed[0]?.createdAt).toBe(replaced[0]?.createdAt);

    const file = join(dir, `${WS}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 });
    expect((await new PreviewStore({ dir }).list(WS)).map((config) => config.name)).toEqual([
      'site',
      'api',
    ]);

    expect((await store.remove(WS, 'site')).map((config) => config.name)).toEqual(['api']);
    expect((await store.remove(WS, 'nope')).map((config) => config.name)).toEqual(['api']);
    await store.removeWorkspace(WS);
    expect(await new PreviewStore({ dir }).list(WS)).toEqual([]);
  });

  it('拒绝出界的目录、改名撞名与改不存在的项', async () => {
    const store = new PreviewStore({});
    await expect(
      store.save(WS, { name: 'web', command: 'x', cwd: '../other' }, { addedBy: 'user' }),
    ).rejects.toBeInstanceOf(HostError);
    await store.save(WS, { name: 'a', command: 'x' }, { addedBy: 'user' });
    await store.save(WS, { name: 'b', command: 'y' }, { addedBy: 'user' });
    await expect(
      store.save(WS, { name: 'b', command: 'x' }, { previous: 'a', addedBy: 'user' }),
    ).rejects.toThrow(/already exists/);
    await expect(
      store.save(WS, { name: 'c', command: 'x' }, { previous: 'zzz', addedBy: 'user' }),
    ).rejects.toThrow(/no run configuration/);
  });

  it('读坏了的文件按空配置处理并告警，丢掉格式不对的项', async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    writeFileSync(join(dir, `${WS}.json`), '{oops');
    expect(await new PreviewStore({ dir, onWarning: (m) => warnings.push(m) }).list(WS)).toEqual(
      [],
    );
    const ok = {
      name: 'web',
      command: 'pnpm run dev',
      cwd: '',
      addedBy: 'user',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    };
    writeFileSync(
      join(dir, `${WS}.json`),
      JSON.stringify({ version: 1, configs: [ok, { ...ok, port: 0 }, ok] }),
    );
    const list = await new PreviewStore({ dir, onWarning: (m) => warnings.push(m) }).list(WS);
    expect(list.map((config) => config.name)).toEqual(['web']);
    expect(warnings).toHaveLength(3);
  });
});
