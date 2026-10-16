import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { parseSkill, scanSkills } from './plugin-skills.js';
import { PluginRegistry } from './plugins.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});
const body = (name: string) =>
  `---\nname: ${name}\ndescription: A useful ${name} skill\nmetadata:\n  short-description: Short description\n---\nBODY-${name}\n`;
function skill(root: string, name: string): string {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), body(name));
  return folder;
}
async function registry() {
  const home = join(temp(), 'home');
  const userHome = join(temp(), 'user');
  const project = join(temp(), 'project');
  const adapter = new EchoAdapter({ stepDelayMs: 0 });
  const store = new PluginRegistry({ home, userHome, roots: () => [project], adapter });
  await store.load();
  return { home, userHome, project, adapter, store };
}

/** 最小 stored ZIP，故意允许测试生成危险路径 / Unix 链接条目。 */
function zip(entries: Array<{ name: string; data?: string; mode?: number }>): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name),
      data = Buffer.from(item.data ?? 'x');
    const local = Buffer.alloc(30),
      head = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    head.writeUInt32LE(0x02014b50);
    head.writeUInt16LE(0x0314, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt32LE(crc32(data), 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(((item.mode ?? 0o100600) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    central.push(head, name);
    offset += local.length + name.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    central.reduce((n, part) => n + part.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

describe('Codex skill metadata and discovery', () => {
  it('YAML、标量修复、折行与 short-description，长度按 Unicode 字符计', () => {
    expect(
      parseSkill(
        '---\nname: alpha\ndescription: Build for AWS: ECS\nmetadata:\n  short-description: >\n    short\n    text\n---\n',
        'fallback',
      ),
    ).toEqual({ name: 'alpha', description: 'Build for AWS: ECS', shortDescription: 'short text' });
    expect(
      parseSkill(
        `---\nname: ${'😀'.repeat(64)}\ndescription: ${'字'.repeat(1024)}\n---`,
        'fallback',
      ).name,
    ).toHaveLength(128);
    for (const text of [
      'No frontmatter',
      '---\nname: x\n---',
      '---\nname: [x]\ndescription: d\n---',
      `---\nname: ${'x'.repeat(65)}\ndescription: d\n---`,
      `---\nname: x\ndescription: ${'x'.repeat(1025)}\n---`,
    ])
      expect(() => parseSkill(text, 'fallback')).toThrow();
    expect(parseSkill('---\ndescription: useful\n---', 'fallback').name).toBe('fallback');
  });
  it('只扫六层，不扫隐藏子目录，不把无效 skill 当成可用项', async () => {
    const root = join(temp(), 'scan');
    skill(join(root, ...Array.from({ length: 5 }, (_, i) => `d${i}`)), 'six');
    skill(join(root, ...Array.from({ length: 6 }, (_, i) => `e${i}`)), 'seven');
    skill(join(root, '.hidden'), 'hidden');
    expect((await scanSkills(root, 'project')).map((item) => item.name)).toEqual(['six']);
  });
});

describe('Host plugin registry', () => {
  it.skipIf(process.platform === 'win32')(
    '数据目录经符号链接访问时，托管路径仍规范化且可重启读取；支持最长 Unicode 名字',
    async () => {
      const real = join(temp(), 'real-home');
      const alias = join(temp(), 'alias-home');
      mkdirSync(real);
      symlinkSync(real, alias, 'dir');
      const adapter = new EchoAdapter();
      const store = new PluginRegistry({
        home: alias,
        userHome: join(temp(), 'user'),
        roots: () => [],
        adapter,
      });
      await store.load();
      const name = '😀'.repeat(64);
      const source = skill(join(temp(), 'sources'), 'long-name');
      writeFileSync(join(source, 'SKILL.md'), body(name));
      const result = await store.install(source);
      expect(result.skills[0]?.path.startsWith(real)).toBe(true);
      expect(result.skills[0]?.name).toBe(name);
      const reboot = new PluginRegistry({
        home: alias,
        userHome: join(temp(), 'user'),
        roots: () => [],
        adapter,
      });
      await reboot.load();
      expect(await reboot.list()).toEqual(result);
    },
  );

  it('注册表写入失败时回滚本次安装的目录，不留下半个插件', async () => {
    const h = await registry();
    mkdirSync(join(h.store.dir, 'registry.json'));
    await expect(h.store.install(skill(join(temp(), 'sources'), 'rollback'))).rejects.toThrow();
    expect((await h.store.list()).skills).toEqual([]);
    expect(readdirSync(h.store.skillsRoot)).toEqual([]);
    expect(readdirSync(h.store.dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });
  it('连接器密钥只回已设置，更新省略保留、null 移除，重启与开关持久化，文件 0600', async () => {
    const h = await registry();
    const changed = vi.fn();
    h.store.watch(changed);
    const first = await h.store.add('test', {
      transport: 'stdio',
      command: 'node',
      env: { KEY: 'test-secret-A', KEEP: 'test-secret-B' },
    });
    expect(first.config).toMatchObject({ env: { KEY: true, KEEP: true } });
    await h.store.update(first.id, {
      config: {
        transport: 'stdio',
        args: ['tool.js'],
        env: { KEY: 'test-secret-C', NEW: 'test-secret-D' },
      },
      enabled: false,
    });
    await h.store.update(first.id, { config: { transport: 'stdio', env: { NEW: null } } });
    const remote = await h.store.add('remote', {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'test-header-secret' },
    });
    await h.store.update(remote.id, { config: { transport: 'http', toolTimeoutSec: 5 } });
    const snapshot = await h.store.list();
    expect(JSON.stringify(snapshot)).not.toContain('test-secret');
    expect(JSON.stringify(snapshot)).not.toContain('test-header-secret');
    expect(snapshot.connectors[0]).toMatchObject({
      enabled: false,
      config: { env: { KEY: true, KEEP: true }, args: ['tool.js'] },
    });
    const engine = await h.store.engineConfig();
    expect(engine.connectors[0]?.config).toMatchObject({
      env: { KEY: 'test-secret-C', KEEP: 'test-secret-B' },
    });
    expect(engine.connectors[1]?.config).toMatchObject({
      headers: { Authorization: 'test-header-secret' },
    });
    const reboot = new PluginRegistry({
      home: h.home,
      userHome: h.userHome,
      roots: () => [h.project],
      adapter: h.adapter,
    });
    await reboot.load();
    expect(await reboot.list()).toEqual(snapshot);
    if (process.platform !== 'win32')
      expect(statSync(join(h.home, 'plugins', 'registry.json')).mode & 0o777).toBe(0o600);
    expect(changed).toHaveBeenCalledTimes(5);
    await reboot.removeConnector(first.id);
    expect((await reboot.list()).connectors.map((item) => item.name)).toEqual(['remote']);
    await h.adapter.dispose();
  });

  it('名字保留、冲突与并发添加在串行事务里拒绝', async () => {
    const { store } = await registry();
    for (const name of ['wevir', 'wevir_custom', 'UPPER', '../x', ''])
      await expect(store.add(name, { transport: 'stdio', command: 'node' })).rejects.toThrow();
    const results = await Promise.allSettled([
      store.add('same', { transport: 'stdio', command: 'node' }),
      store.add('same', { transport: 'stdio', command: 'node' }),
    ]);
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  });

  it('目录、SKILL.md 与 ZIP 安装，保留资源与 agents/openai.yaml，开关 / 移除持久化', async () => {
    const h = await registry();
    const source = skill(join(temp(), 'sources'), 'folder');
    mkdirSync(join(source, 'agents'));
    writeFileSync(
      join(source, 'agents', 'openai.yaml'),
      'interface:\n  display_name: Folder skill\n',
    );
    mkdirSync(join(source, 'scripts'));
    writeFileSync(join(source, 'scripts', 'run.js'), 'export const value = 1;');
    const a = (await h.store.install(source)).skills.find((item) => item.name === 'folder');
    expect(a?.source).toBe('wevir');
    expect(
      readFileSync(join(h.home, 'plugins', 'skills', 'folder', 'agents', 'openai.yaml'), 'utf8'),
    ).toContain('Folder skill');
    expect(existsSync(join(h.home, 'plugins', 'skills', 'folder', 'scripts', 'run.js'))).toBe(true);
    const single = skill(join(temp(), 'sources'), 'single');
    await h.store.install(join(single, 'SKILL.md'));
    const archive = join(temp(), 'skill.zip');
    writeFileSync(archive, zip([{ name: 'export/zip-skill/SKILL.md', data: body('zip-skill') }]));
    await h.store.install(archive);
    expect((await h.store.list()).skills.map((item) => item.name)).toEqual([
      'folder',
      'single',
      'zip-skill',
    ]);
    await expect(h.store.install(source)).rejects.toThrow('already exists');
    await h.store.setSkillEnabled(a?.id as string, false);
    const reboot = new PluginRegistry({
      home: h.home,
      userHome: h.userHome,
      roots: () => [],
      adapter: h.adapter,
    });
    await reboot.load();
    expect((await reboot.list()).skills.find((item) => item.name === 'folder')?.enabled).toBe(
      false,
    );
    await reboot.removeSkill(a?.id as string);
    expect(existsSync(join(h.home, 'plugins', 'skills', 'folder'))).toBe(false);
    expect((await reboot.list()).skills.map((item) => item.name)).toEqual(['single', 'zip-skill']);
  });

  it.each(['.codex-plugin', '.claude-plugin'])(
    '展开 %s 包的默认 skills / .mcp.json，与行内服务表',
    async (marker) => {
      const h = await registry();
      const root = join(temp(), 'package');
      mkdirSync(join(root, marker), { recursive: true });
      writeFileSync(
        join(root, marker, 'plugin.json'),
        JSON.stringify({
          name: 'bundle',
          version: '1.0',
          description: 'A package',
          interface: { displayName: 'Package' },
        }),
      );
      skill(join(root, 'skills'), 'bundled');
      writeFileSync(
        join(root, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            package_mcp: { command: 'node', args: ['tool.mjs'], env: { KEY: 'package-secret' } },
          },
        }),
      );
      const result = await h.store.install(root);
      expect(result.skills.map((item) => item.name)).toEqual(['bundled']);
      expect(result.connectors[0]).toMatchObject({
        name: 'package_mcp',
        config: { env: { KEY: true } },
      });
      const inline = join(temp(), 'inline');
      mkdirSync(join(inline, marker), { recursive: true });
      writeFileSync(
        join(inline, marker, 'plugin.json'),
        JSON.stringify({
          name: 'inline',
          skills: [],
          mcpServers: {
            direct: { url: 'https://example.com/mcp', headers: { Key: 'header-secret' } },
          },
        }),
      );
      expect((await h.store.install(inline)).connectors.map((item) => item.name)).toEqual([
        'package_mcp',
        'direct',
      ]);
    },
  );

  it('用户 / 项目项默认关闭，按路径记选择，后来新增项仍关闭；不会删除外部原件', async () => {
    const h = await registry();
    skill(join(h.userHome, '.agents', 'skills'), 'user-skill');
    const project = skill(join(h.project, '.codex', 'skills'), 'project-skill');
    const external = (await h.store.list()).skills;
    expect(external).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'user-skill', source: 'user', enabled: false }),
        expect.objectContaining({ name: 'project-skill', source: 'project', enabled: false }),
      ]),
    );
    const user = external.find((item) => item.source === 'user');
    await h.store.setSkillEnabled(user?.id as string, true);
    await expect(h.store.removeSkill(user?.id as string)).rejects.toThrow('Only Wevir');
    skill(join(h.project, '.agents', 'skills'), 'new-project-skill');
    expect((await h.store.engineConfig()).skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'user-skill', enabled: true }),
        expect.objectContaining({ name: 'new-project-skill', enabled: false }),
      ]),
    );
    expect(existsSync(project)).toBe(true);
  });

  it.each([
    { name: '../escape/SKILL.md', data: body('escape') },
    { name: '/absolute/SKILL.md', data: body('absolute') },
    { name: 'C:/drive/SKILL.md', data: body('drive') },
    { name: 'link', data: '../../outside', mode: 0o120777 },
  ])('拒绝危险 ZIP 条目 $name，失败没有留下注册表或 skill', async (entry) => {
    const { store, home } = await registry();
    const archive = join(temp(), 'bad.zip');
    writeFileSync(archive, zip([entry]));
    await expect(store.install(archive)).rejects.toThrow();
    expect(await store.list()).toEqual({ connectors: [], skills: [] });
    expect(readdirSync(join(home, 'plugins'))).toEqual(['skills']);
  });

  it.skipIf(process.platform === 'win32')(
    '拒绝目录和资源的符号链接，包路径越界、重复条目与无效元数据也拒绝',
    async () => {
      const h = await registry();
      const root = skill(join(temp(), 'sources'), 'linked');
      symlinkSync(join(root, 'SKILL.md'), join(root, 'copy.md'));
      await expect(h.store.install(root)).rejects.toThrow('symbolic');
      const packageDir = join(temp(), 'package');
      mkdirSync(join(packageDir, '.codex-plugin'), { recursive: true });
      writeFileSync(
        join(packageDir, '.codex-plugin', 'plugin.json'),
        JSON.stringify({ name: 'bad', skills: './../sources' }),
      );
      await expect(h.store.install(packageDir)).rejects.toThrow('path');
      const dup = join(temp(), 'dup.zip');
      writeFileSync(
        dup,
        zip([
          { name: 'SKILL.md', data: body('dup') },
          { name: 'SKILL.md', data: body('dup') },
        ]),
      );
      await expect(h.store.install(dup)).rejects.toThrow('duplicate');
      const invalid = skill(join(temp(), 'sources'), 'invalid');
      writeFileSync(join(invalid, 'SKILL.md'), '---\nname: bad\n---');
      await expect(h.store.install(invalid)).rejects.toThrow();
      expect((await h.store.list()).skills).toEqual([]);
    },
  );
});

describe('plugins RPC + echo', () => {
  it('hello 声明功能、注册表通知、echo 收到全局启用项，重启后还能列出', async () => {
    const home = join(temp(), 'host');
    const launch = async () => {
      const host = await startHost({
        home,
        engine: 'echo',
        adapter: new EchoAdapter({ stepDelayMs: 0 }),
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      running.push(host);
      const client = await TestRpcClient.connect(host.url);
      clients.push(client);
      const info = JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8'));
      const hello = await client.hello(info.token);
      expect(hello.result.features.plugins).toBe(true);
      return { host, client };
    };
    const { host, client } = await launch();
    await client.request('plugins.list', {});
    const received: string[] = [];
    client.ws.on('message', (raw) => {
      const value = JSON.parse(raw.toString());
      if (value.method === 'plugins.changed') received.push(value.method);
    });
    await client.request('connector.add', {
      name: 'echo_test',
      config: { transport: 'stdio', command: 'node', env: { SECRET: 'rpc-test-secret' } },
    });
    const path = skill(join(temp(), 'sources'), 'echo-skill');
    await client.request('skill.install', { path });
    await client.until(() => (received.length >= 2 ? true : undefined), 'plugins.changed');
    await client.request('provider.upsert', {
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'mock' }],
      defaultModelId: 'mock',
      apiKey: 'mock-not-a-secret',
    });
    const { session } = await client.request('session.create', { providerId: 'mock' });
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    await client.request('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text: 'plugins' }],
    });
    await client.until(
      () => client.events(subscriptionId).find((item) => item.type === 'turn.finished'),
      'turn.finished',
    );
    expect(
      client
        .events(subscriptionId)
        .filter((item) => item.type === 'assistant.message')
        .map((item) => JSON.stringify(item.payload))
        .join(),
      JSON.stringify(client.events(subscriptionId)),
    ).toContain('Connectors: echo_test');
    expect(
      client
        .events(subscriptionId)
        .some((item) => JSON.stringify(item).includes('Skills: echo-skill')),
    ).toBe(true);
    const before = await client.request('plugins.list', {});
    expect(JSON.stringify(before)).not.toContain('rpc-test-secret');
    client.ws.terminate();
    await host.shutdown();
    const restarted = await launch();
    expect(await restarted.client.request('plugins.list', {})).toEqual(before);
  }, 30_000);
});
