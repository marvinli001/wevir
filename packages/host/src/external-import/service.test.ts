import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import type { WorkspaceRecord } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { MEMORY_MAX_PER_SCOPE, MemoryStore } from '../memory.js';
import { PluginRegistry } from '../plugins.js';
import { useTempDir } from '../test-utils.js';
import { ExternalImport } from './service.js';

const temp = useTempDir();

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const skillText = (name: string, body = 'Body') =>
  `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
const note = (name: string, body: string, type = 'feedback') =>
  `---\nname: ${name}\ndescription: ${name} description\ntype: ${type}\n---\n${body}\n`;

async function setup() {
  const userHome = join(temp(), 'home');
  const folderA = join(temp(), 'proj-a');
  const folderB = join(temp(), 'proj-b');
  const workspaces: WorkspaceRecord[] = [
    { id: 'ws_a', rootPath: folderA, displayName: 'A', createdAt: '', updatedAt: '' },
    { id: 'ws_b', rootPath: folderB, displayName: 'B', createdAt: '', updatedAt: '' },
    {
      id: 'ws_gone',
      rootPath: join(temp(), 'gone'),
      displayName: 'Gone',
      createdAt: '',
      updatedAt: '',
      removedAt: '2026-10-01T00:00:00.000Z',
    },
  ];
  const memory = new MemoryStore({ dir: join(temp(), 'data', 'memory') });
  const plugins = new PluginRegistry({
    home: join(temp(), 'data'),
    userHome,
    roots: () => [],
    adapter: new EchoAdapter({ stepDelayMs: 0 }),
  });
  await plugins.load();
  const importer = new ExternalImport({
    userHome,
    env: {},
    workspaces: {
      list: () => workspaces.filter((item) => item.removedAt === undefined),
      get: (id) => workspaces.find((item) => item.id === id),
    },
    memory,
    plugins,
  });
  const claudeMemory = (dir: string, file: string, text: string) =>
    put(join(userHome, '.claude', 'projects', dir, 'memory', file), text);
  return { userHome, folderA, folderB, memory, plugins, importer, claudeMemory };
}

describe('import.scan / import.apply：记忆', () => {
  it('写入带 importedFrom，重启后读回；再导一次是 skipped，改过的是 exists，可改名导入', async () => {
    const { importer, memory, claudeMemory, folderA } = await setup();
    const encoded = folderA.replace(/[^a-zA-Z0-9]/g, '-');
    const path = claudeMemory(encoded, 'tabs.md', note('tabs', 'Use tabs.'));
    claudeMemory('-other', 'global.md', note('global-one', 'G', 'user'));
    const first = await importer.scan('claude');
    const tabs = first.memories.find((item) => item.name === 'tabs');
    expect(tabs).toMatchObject({
      status: 'new',
      recommended: true,
      scope: 'project',
      workspaceId: 'ws_a',
    });
    const changes: unknown[] = [];
    memory.watch((change) => changes.push(change));
    const keys = first.memories.map((item) => ({ key: item.key }));
    const applied = await importer.apply('claude', keys);
    expect(applied.map((item) => [item.name, item.outcome])).toEqual([
      ['global-one', 'imported'],
      ['tabs', 'imported'],
    ]);
    expect(changes).toContainEqual({ scope: 'project', workspaceId: 'ws_a', name: 'tabs' });

    const read = await memory.read('project', 'ws_a', 'tabs');
    const source = { by: 'user', at: read.updatedAt, importedFrom: { app: 'claude', path } };
    expect(read.origin).toEqual(source);
    expect(read.lastEdit).toEqual(source);
    const file = readFileSync(join(memory.dir, 'projects', 'ws_a', 'tabs.md'), 'utf8');
    expect(file).toContain('created-imported-app: claude');
    expect(file).toContain(`updated-imported-path: ${path}`);
    // 新的 MemoryStore 实例（重启）从 frontmatter 读回来源，列表里也有。
    const reopened = new MemoryStore({ dir: memory.dir });
    expect((await reopened.read('project', 'ws_a', 'tabs')).origin?.importedFrom).toEqual({
      app: 'claude',
      path,
    });
    const listed = await reopened.listAll('ws_a');
    expect(listed.notes.find((item) => item.name === 'tabs')?.origin?.importedFrom?.app).toBe(
      'claude',
    );

    const second = await importer.scan('claude');
    expect(second.memories.map((item) => [item.name, item.status, item.recommended])).toEqual([
      ['global-one', 'same', false],
      ['tabs', 'same', false],
    ]);
    expect((await importer.apply('claude', [{ key: tabs?.key ?? '' }]))[0]?.outcome).toBe(
      'skipped',
    );

    // 源文件改了：同名但内容不同，不覆盖；换个名字可以导入。
    claudeMemory(encoded, 'tabs.md', note('tabs', 'Use spaces now.'));
    const third = await importer.scan('claude');
    const changed = third.memories.find((item) => item.name === 'tabs');
    expect(changed).toMatchObject({ status: 'exists', recommended: false });
    expect(await importer.apply('claude', [{ key: changed?.key ?? '' }])).toEqual([
      { key: changed?.key, outcome: 'failed', kind: 'memory', name: 'tabs', reason: 'exists' },
    ]);
    expect((await memory.read('project', 'ws_a', 'tabs')).content).toBe('Use tabs.');
    const renamed = await importer.apply('claude', [{ key: changed?.key ?? '', name: 'tabs-2' }]);
    expect(renamed[0]).toMatchObject({ outcome: 'imported', name: 'tabs-2' });
    expect((await memory.read('project', 'ws_a', 'tabs-2')).content).toBe('Use spaces now.');
  });

  it('改范围、不合规的名字、项目不在、源里没有、候选有问题', async () => {
    const { importer, memory, claudeMemory } = await setup();
    claudeMemory('-x', 'one.md', note('one', 'One'));
    claudeMemory('-x', 'leak.md', note('leak', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
    const scan = await importer.scan('claude');
    const one = scan.memories.find((item) => item.name === 'one')?.key ?? '';
    const leak = scan.memories.find((item) => item.name === 'leak')?.key ?? '';
    const results = await importer.apply('claude', [
      { key: one, name: 'Bad Name' },
      { key: one, scope: 'project' },
      { key: one, scope: 'project', workspaceId: 'ws_gone' },
      { key: 'memory:missing' },
      { key: leak },
      { key: one, scope: 'project', workspaceId: 'ws_b' },
    ]);
    expect(results.map((item) => item.reason ?? item.outcome)).toEqual([
      'invalid_name',
      'no_workspace',
      'no_workspace',
      'not_found',
      'looks_secret',
      'imported',
    ]);
    expect((await memory.read('project', 'ws_b', 'one')).content).toBe('One');
  });

  it('范围已满时报 limit', async () => {
    const { importer, memory, claudeMemory } = await setup();
    for (let index = 0; index < MEMORY_MAX_PER_SCOPE; index += 1)
      await memory.save('global', undefined, {
        name: `n${index}`,
        type: 'user',
        description: 'd',
        content: 'c',
      });
    claudeMemory('-x', 'extra.md', note('extra', 'E'));
    const scan = await importer.scan('claude');
    const results = await importer.apply('claude', [{ key: scan.memories[0]?.key ?? '' }]);
    expect(results[0]).toMatchObject({ outcome: 'failed', reason: 'limit' });
  });
});

describe('import.apply：连接器', () => {
  it('不带凭据：值留空成 missingInputs，不交给引擎；用 connector.update 填好后恢复', async () => {
    const { importer, plugins, userHome } = await setup();
    const path = put(
      join(userHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_value', LOG: 'debug' } },
          leaky: { command: 'srv', args: ['--api-key', 'abcdef123456'] },
        },
      }),
    );
    const scan = await importer.scan('claude');
    expect(scan.connectors.map((item) => [item.name, item.status, item.problem])).toEqual([
      ['github', 'new', undefined],
      ['leaky', 'new', 'looks_secret'],
    ]);
    expect(scan.connectors[0]?.config).toEqual({
      transport: 'stdio',
      command: 'gh-mcp',
      env: { GITHUB_TOKEN: true, LOG: true },
    });
    const results = await importer.apply(
      'claude',
      scan.connectors.map((item) => ({ key: item.key })),
    );
    expect(results.map((item) => item.reason ?? item.outcome)).toEqual([
      'imported',
      'looks_secret',
    ]);
    const [connector] = plugins.connectors();
    expect(connector).toMatchObject({
      name: 'github',
      missingInputs: ['GITHUB_TOKEN', 'LOG'],
      importedFrom: { app: 'claude', path },
    });
    expect(JSON.stringify(await plugins.list())).not.toContain('ghp_value');
    expect((await plugins.engineConfig()).connectors).toEqual([]);
    // 再扫描：同名同形状是 same。
    const again = await importer.scan('claude');
    expect(again.connectors[0]).toMatchObject({ status: 'same', recommended: false });
    expect(
      (await importer.apply('claude', [{ key: again.connectors[0]?.key ?? '' }]))[0]?.outcome,
    ).toBe('skipped');

    await plugins.update(connector?.id ?? '', {
      config: { transport: 'stdio', env: { GITHUB_TOKEN: 'filled-in' } },
    });
    expect(plugins.connectors()[0]?.missingInputs).toEqual(['LOG']);
    expect((await plugins.engineConfig()).connectors).toEqual([]);
    await plugins.update(connector?.id ?? '', {
      config: { transport: 'stdio', env: { LOG: null } },
    });
    expect(plugins.connectors()[0]?.missingInputs).toBeUndefined();
    expect((await plugins.engineConfig()).connectors).toMatchObject([
      { name: 'github', config: { env: { GITHUB_TOKEN: 'filled-in' } }, enabled: true },
    ]);
    // 删掉了一个键：形状不同，是 exists。
    expect((await importer.scan('claude')).connectors[0]?.status).toBe('exists');
  });

  it('项目范围：只交给那个项目；名字在全局 ∪ 同一项目里唯一，不同项目可以重名', async () => {
    const { importer, plugins, folderA, folderB } = await setup();
    put(
      join(folderA, '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'docs-a' } } }),
    );
    put(
      join(folderB, '.mcp.json'),
      JSON.stringify({ mcpServers: { docs: { command: 'docs-b' } } }),
    );
    const scan = await importer.scan('claude');
    expect(scan.connectors.map((item) => [item.name, item.workspaceId])).toEqual([
      ['docs', 'ws_a'],
      ['docs', 'ws_b'],
    ]);
    const results = await importer.apply(
      'claude',
      scan.connectors.map((item) => ({ key: item.key })),
    );
    expect(results.map((item) => item.outcome)).toEqual(['imported', 'imported']);
    expect((await plugins.engineConfig()).connectors).toEqual([]);
    expect(plugins.projectConnectors('ws_a')).toMatchObject([
      { name: 'docs', config: { command: 'docs-a' } },
    ]);
    expect(plugins.projectConnectors('ws_b')).toMatchObject([
      { name: 'docs', config: { command: 'docs-b' } },
    ]);
    // 全局的同名：和项目里的冲突。
    await expect(plugins.add('docs', { transport: 'stdio', command: 'g' })).rejects.toThrow(
      /already exists/,
    );
    const asGlobal = await importer.apply('claude', [
      { key: scan.connectors[0]?.key ?? '', scope: 'global' },
    ]);
    expect(asGlobal[0]).toMatchObject({ outcome: 'failed', reason: 'exists' });
    // 全局的 tools，项目里不能再有同名的。
    await plugins.add('tools', { transport: 'stdio', command: 't' });
    await expect(
      plugins.add('tools', { transport: 'stdio', command: 't' }, undefined, undefined, {
        workspaceId: 'ws_a',
      }),
    ).rejects.toThrow(/already exists/);
    const renamed = await importer.apply('claude', [
      { key: scan.connectors[0]?.key ?? '', workspaceId: 'ws_b', name: 'docs-from-a' },
    ]);
    expect(renamed[0]).toMatchObject({ outcome: 'imported', name: 'docs-from-a' });
    expect(plugins.projectConnectors('ws_b').map((item) => item.name)).toEqual([
      'docs',
      'docs-from-a',
    ]);
    expect(
      (await importer.apply('claude', [{ key: scan.connectors[0]?.key ?? '', name: 'Bad!' }]))[0]
        ?.reason,
    ).toBe('invalid_name');
    expect(
      (
        await importer.apply('claude', [
          { key: scan.connectors[0]?.key ?? '', workspaceId: 'ws_gone' },
        ])
      )[0]?.reason,
    ).toBe('no_workspace');
  });
});

describe('import.apply：skills', () => {
  it('复制进 Wevir、记下来源；同名同内容 skipped，同名不同内容 exists，不能改名；Antigravity 重复列出的去重', async () => {
    const { importer, plugins, userHome } = await setup();
    const source = put(join(userHome, '.codex', 'skills', 'alpha', 'SKILL.md'), skillText('alpha'));
    put(join(userHome, '.codex', 'skills', 'alpha', 'scripts', 'run.sh'), 'echo hi\n');
    put(
      join(userHome, '.gemini', 'config', 'skills.json'),
      JSON.stringify({ entries: [{ path: join(userHome, '.codex', 'skills') }] }),
    );
    put(
      join(userHome, '.gemini', 'config', 'skills', 'alpha-copy', 'SKILL.md'),
      skillText('alpha'),
    );
    const antigravity = await importer.scan('antigravity');
    expect(antigravity.skills.map((item) => item.name)).toEqual(['alpha']);

    const scan = await importer.scan('codex');
    expect(scan.skills).toMatchObject([{ name: 'alpha', status: 'new', recommended: true }]);
    const key = scan.skills[0]?.key ?? '';
    expect(await importer.apply('codex', [{ key, name: 'other' }])).toMatchObject([
      { outcome: 'failed', reason: 'invalid_name' },
    ]);
    expect(await importer.apply('codex', [{ key }])).toMatchObject([
      { outcome: 'imported', kind: 'skill', name: 'alpha' },
    ]);
    const skill = (await plugins.list()).skills.find((item) => item.name === 'alpha');
    expect(skill).toMatchObject({ source: 'wevir', enabled: true, importedFrom: { app: 'codex' } });
    expect(skill?.importedFrom?.path).toContain(join('skills', 'alpha', 'SKILL.md'));
    expect(skill?.path.startsWith(plugins.skillsRoot)).toBe(true);
    expect(readFileSync(join(dirname(skill?.path ?? ''), 'scripts', 'run.sh'), 'utf8')).toBe(
      'echo hi\n',
    );
    // 重启后还在。
    const reloaded = new PluginRegistry({
      home: join(temp(), 'data'),
      userHome,
      roots: () => [],
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
    });
    await reloaded.load();
    expect((await reloaded.skills()).find((item) => item.name === 'alpha')?.importedFrom?.app).toBe(
      'codex',
    );

    expect((await importer.scan('codex')).skills[0]?.status).toBe('same');
    expect((await importer.apply('codex', [{ key }]))[0]?.outcome).toBe('skipped');
    writeFileSync(source, skillText('alpha', 'Changed'));
    const changed = await importer.scan('codex');
    expect(changed.skills[0]).toMatchObject({ status: 'exists', recommended: false });
    expect(
      (await importer.apply('codex', [{ key: changed.skills[0]?.key ?? '' }]))[0]?.reason,
    ).toBe('exists');
  });
});
