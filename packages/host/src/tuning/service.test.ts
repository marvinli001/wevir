import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProfileVersionId, WorkspaceId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { discoverRuleFiles } from '../rule-files.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { ProfileBlobStore } from './blobs.js';
import { ProfileCollector, sha256 } from './profile.js';
import { TuningService } from './service.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-21T00:00:00.000Z';
const WS = 'ws_1' as WorkspaceId;

function setup() {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const project = join(root, 'project');
  const chats = join(root, 'chats');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(chats);
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'user rules');
  writeFileSync(join(project, 'AGENTS.md'), 'v1');
  const storage = storages.open(join(root, 'data'));
  storage.workspaces.insert({
    id: WS,
    rootPath: project,
    displayName: 'project',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.workspaces.insert({
    id: 'ws_chats',
    rootPath: chats,
    displayName: 'chats',
    createdAt: T0,
    updatedAt: T0,
  });
  const settings = { agentInstructions: '' };
  const blobs = new ProfileBlobStore(join(root, 'data', 'tuning', 'blobs'));
  let clock = Date.parse(T0);
  const service = new TuningService({
    storage,
    collector: new ProfileCollector({
      userHome: home,
      ruleFiles: (cwd) => discoverRuleFiles({ cwd, home, env: {} }),
      settings: () => settings,
    }),
    blobs,
    wevirVersion: '0.1.0',
    isChats: (workspace) => workspace.rootPath === chats,
    now: () => new Date(clock),
  });
  const changes: (string | undefined)[] = [];
  service.watch((workspaceId) => changes.push(workspaceId));
  return {
    root,
    project,
    storage,
    settings,
    blobs,
    service,
    changes,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('TuningService', () => {
  it('版本惰性生成：指纹没变沿用，变了开下一版；取当前档案不开版本，只标待生效', async () => {
    const env = setup();
    const before = await env.service.get({ workspaceId: WS });
    expect(before).toMatchObject({ pending: false, pendingLayers: [] });
    expect(before.latest).toBeUndefined();
    expect(env.storage.profileVersions.latest(WS)).toBeUndefined();

    const v1 = await env.service.ensure(WS);
    expect(v1).toMatchObject({ seq: 1, fingerprint: before.profile.fingerprint });
    expect(await env.service.ensure(WS)).toEqual(v1);
    expect(env.changes).toEqual([WS]);

    writeFileSync(join(env.project, 'AGENTS.md'), 'v2');
    const pending = await env.service.get({ workspaceId: WS });
    expect(pending).toMatchObject({ pending: true, pendingLayers: ['rules'], latest: { seq: 1 } });
    expect(env.storage.profileVersions.latest(WS)?.seq).toBe(1);

    const v2 = await env.service.ensure(WS);
    expect(v2?.seq).toBe(2);
    expect((await env.service.get({ workspaceId: WS })).pending).toBe(false);
  });

  it('“对话”工作区用全局档案；全局与项目各自编号', async () => {
    const env = setup();
    const global = await env.service.ensure('ws_chats');
    expect(global?.seq).toBe(1);
    expect(env.storage.profileVersions.latest(undefined)?.id).toBe(global?.id);
    expect((await env.service.get({})).latest?.id).toBe(global?.id);
    expect((await env.service.ensure(WS))?.seq).toBe(1);
    expect(env.changes).toEqual([undefined, WS]);
  });

  it('版本列表：新的在前、会话数、与前一版的变化、分页；版本详情与会话', async () => {
    const env = setup();
    const v1 = await env.service.ensure(WS);
    writeFileSync(join(env.project, 'AGENTS.md'), 'v2');
    env.settings.agentInstructions = 'Be brief.';
    const v2 = await env.service.ensure(WS);
    writeFileSync(join(env.project, 'CLAUDE.md'), 'tabs');
    const v3 = await env.service.ensure(WS);
    env.storage.sessions.insert({
      id: 'ses_a',
      workspaceId: WS,
      cwd: env.project,
      engine: 'echo',
      engineSessionId: 'e1',
      providerId: 'echo',
      modelId: 'echo',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: T0,
      updatedAt: T0,
      ...(v2 !== undefined && { profileVersionId: v2.id }),
    });

    const page = env.service.versions({ workspaceId: WS, limit: 2 });
    expect(page.versions.map((version) => version.seq)).toEqual([3, 2]);
    expect(page.nextCursor).toBe('2');
    expect(page.versions[0]?.changes).toEqual([
      { key: 'rules', added: 1, removed: 0, modified: 0 },
    ]);
    expect(page.versions[1]).toMatchObject({
      sessions: 1,
      changes: [
        { key: 'rules', added: 0, removed: 0, modified: 1 },
        { key: 'instructions', added: 1, removed: 0, modified: 0 },
      ],
    });
    const rest = env.service.versions({ workspaceId: WS, cursor: page.nextCursor });
    expect(rest.versions.map((version) => version.id)).toEqual([v1?.id]);
    expect(rest.versions[0]?.changes).toBeUndefined();
    expect(rest.nextCursor).toBeUndefined();

    const detail = env.service.version({ versionId: v2?.id as ProfileVersionId });
    expect(detail.sessionIds).toEqual(['ses_a']);
    expect(detail.version).toMatchObject({ seq: 2, wevirVersion: '0.1.0', sessions: 1 });
    expect(detail.version.layers.map((layer) => layer.key)).toHaveLength(8);
    expect(v3?.seq).toBe(3);
  });

  it('两版对比与当前对比；文本按散列取', async () => {
    const env = setup();
    const v1 = await env.service.ensure(WS);
    writeFileSync(join(env.project, 'AGENTS.md'), 'v2');
    const v2 = await env.service.ensure(WS);
    const diff = await env.service.diff({
      from: v1?.id as ProfileVersionId,
      to: v2?.id as ProfileVersionId,
    });
    expect(diff.layers).toEqual([
      {
        key: 'rules',
        items: [
          expect.objectContaining({
            label: 'AGENTS.md',
            change: 'modified',
            before: expect.objectContaining({ hash: sha256('v1') }),
            after: expect.objectContaining({ hash: sha256('v2') }),
          }),
        ],
      },
    ]);
    expect(await env.service.blob({ hash: sha256('v1') })).toEqual({ text: 'v1' });
    expect(await env.service.blob({ hash: sha256('nothing') })).toEqual({});

    writeFileSync(join(env.project, 'GEMINI.md'), 'gemini');
    const current = await env.service.diff({ from: v2?.id as ProfileVersionId, to: 'current' });
    expect(current.to).not.toHaveProperty('id');
    expect(current.layers[0]?.items).toEqual([
      expect.objectContaining({ label: 'GEMINI.md', change: 'added' }),
    ]);
  });

  it('没有的版本回 PROFILE_VERSION_NOT_FOUND，没有的项目回 WORKSPACE_NOT_FOUND', async () => {
    const env = setup();
    const missing = 'pfv_missing' as ProfileVersionId;
    expect(() => env.service.version({ versionId: missing })).toThrow(
      expect.objectContaining({ code: 'PROFILE_VERSION_NOT_FOUND' }),
    );
    await expect(env.service.diff({ from: missing, to: 'current' })).rejects.toSatisfy((error) =>
      isHostError(error, 'PROFILE_VERSION_NOT_FOUND'),
    );
    await expect(env.service.get({ workspaceId: 'ws_gone' as WorkspaceId })).rejects.toSatisfy(
      (error) => isHostError(error, 'WORKSPACE_NOT_FOUND'),
    );
  });

  it('清理：版本引用的文本留着，没引用的放过一天才删', async () => {
    const env = setup();
    await env.service.ensure(WS);
    writeFileSync(join(env.project, 'AGENTS.md'), 'unversioned');
    await env.service.get({ workspaceId: WS });
    const path = join(env.blobs.dir, sha256('unversioned'));
    expect(existsSync(path)).toBe(true);
    expect(await env.service.prune()).toBe(0);
    const old = new Date(Date.parse(T0) - 1000);
    for (const name of readdirSync(env.blobs.dir)) utimesSync(join(env.blobs.dir, name), old, old);
    env.tick(24 * 60 * 60 * 1000);
    expect(await env.service.prune()).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(env.blobs.dir, sha256('v1')))).toBe(true);
  });
});
