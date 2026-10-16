// Wevir 插件包（0.42.0）：安装、升级、卸载、开关、输入项、导入 Claude / Codex 包与拒绝规则。样例包在 test-fixtures/。
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginsList } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { PluginRegistry } from './plugins.js';
import { TestRpcClient, useTempDir, zip } from './test-utils.js';

const temp = useTempDir();
const running: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of running.splice(0)) await host.shutdown();
});

const fixture = (name: string) =>
  fileURLToPath(new URL(`./test-fixtures/${name}`, import.meta.url));
const SECRET = 'package-token-not-a-secret';

async function registry(name = 'home') {
  const home = join(temp(), name);
  const userHome = join(temp(), 'user');
  const adapter = new EchoAdapter({ stepDelayMs: 0 });
  const store = new PluginRegistry({ home, userHome, roots: () => [], adapter });
  await store.load();
  return { home, userHome, adapter, store };
}
/** 复制一份样例包，按需改清单。 */
function copyFixture(name: string, edit?: (manifest: Record<string, unknown>) => void): string {
  const root = join(temp(), 'sources', `${name}-${Math.random().toString(36).slice(2)}`);
  cpSync(fixture(name), root, { recursive: true });
  if (edit) {
    const file = join(root, 'wevir-plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    edit(manifest);
    writeFileSync(file, JSON.stringify(manifest));
  }
  return root;
}
function zipFolder(root: string, prefix: string): string {
  const entries: Array<{ name: string; data: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        entries.push({
          name: `${prefix}${relative(root, path).split('\\').join('/')}`,
          data: readFileSync(path, 'utf8'),
        });
    }
  };
  walk(root);
  const file = join(temp(), `${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(file, zip(entries));
  return file;
}

describe('Wevir plugin packages', () => {
  it('装文件夹：插件、连接器与 skill 各带 pluginId；缺必填输入的连接器不交给引擎，填好后展开占位符', async () => {
    const h = await registry();
    const { plugin, ignored } = await h.store.installPlugin(fixture('wevir-plugin'));
    expect(ignored).toEqual([]);
    const dir = join(h.store.packagesRoot, 'sample-tools');
    expect(plugin).toMatchObject({
      id: 'sample-tools',
      name: 'Sample tools',
      version: '1.0.0',
      author: { name: 'Wevir tests' },
      source: 'wevir',
      enabled: true,
      path: dir,
      inputs: [
        { key: 'TOKEN', label: 'Token', secret: true, required: true, set: false },
        { key: 'REGION', label: 'Region', secret: false, required: false, set: false },
      ],
    });
    expect(plugin.iconUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const list = await h.store.list();
    const connector = list.connectors.find((item) => item.pluginId === 'sample-tools');
    expect(connector).toMatchObject({
      id: plugin.connectors[0],
      name: 'sample-tools_api',
      missingInputs: ['TOKEN'],
      enabled: true,
      config: {
        args: [`\${pluginDir}/server/mcp.mjs`, `\${input:REGION}`],
        env: { PACKAGE_TOKEN: true },
      },
    });
    const skill = list.skills.find((item) => item.name === 'package-canary');
    expect(skill).toMatchObject({ id: plugin.skills[0], pluginId: 'sample-tools', enabled: true });
    expect(skill?.path).toBe(join(dir, 'skills', 'package-canary', 'SKILL.md'));
    expect(existsSync(join(dir, 'server', 'mcp.mjs'))).toBe(true);
    let engine = await h.store.engineConfig();
    expect(engine.connectors).toEqual([]);
    expect(engine.skills).toContainEqual({
      name: 'package-canary',
      path: skill?.path,
      enabled: true,
    });

    const updated = await h.store.setPluginInputs('sample-tools', { TOKEN: SECRET, REGION: 'eu' });
    expect(updated.inputs).toEqual([
      { key: 'TOKEN', label: 'Token', secret: true, required: true, set: true },
      {
        key: 'REGION',
        label: 'Region',
        description: 'Data region',
        secret: false,
        required: false,
        set: true,
        value: 'eu',
      },
    ]);
    engine = await h.store.engineConfig();
    expect(engine.connectors).toEqual([
      {
        name: 'sample-tools_api',
        enabled: true,
        config: {
          transport: 'stdio',
          command: 'node',
          args: [`${dir}/server/mcp.mjs`, 'eu'],
          env: { PACKAGE_TOKEN: SECRET },
          enabled: true,
        },
      },
    ]);
    expect(engine.secrets).toEqual([SECRET]);
    expect(JSON.stringify(engine)).not.toContain(`\${`);
    const after = await h.store.list();
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(after.connectors.find((item) => item.pluginId)?.missingInputs).toBeUndefined();
    const file = join(h.home, 'plugins', 'registry.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // 可选项清空后展开成空字符串，连接器照常启动。
    await h.store.setPluginInputs('sample-tools', { REGION: null });
    expect((await h.store.engineConfig()).connectors[0]?.config).toMatchObject({
      args: [`${dir}/server/mcp.mjs`, ''],
    });
    await expect(h.store.setPluginInputs('sample-tools', { OTHER: 'x' })).rejects.toThrow(
      'no input "OTHER"',
    );
  });

  it('装 ZIP（带一层导出文件夹）并在安装时填输入；重启后插件、输入与开关都还在', async () => {
    const h = await registry();
    const archive = zipFolder(fixture('wevir-plugin'), 'sample-tools/');
    const { plugin } = await h.store.installPlugin(archive, { inputs: { TOKEN: SECRET } });
    expect(plugin.inputs[0]).toMatchObject({ key: 'TOKEN', set: true });
    await h.store.setPluginEnabled('sample-tools', false);
    const before = await h.store.list();
    const reboot = new PluginRegistry({
      home: h.home,
      userHome: h.userHome,
      roots: () => [],
      adapter: h.adapter,
    });
    await reboot.load();
    expect(await reboot.list()).toEqual(before);
    expect(before.plugins?.[0]?.enabled).toBe(false);
  });

  it('整体开关与单项开关：生效 = 插件开且该项开；列表里的 enabled 是该项自己的开关', async () => {
    const h = await registry();
    const { plugin } = await h.store.installPlugin(fixture('wevir-plugin'), {
      inputs: { TOKEN: SECRET },
    });
    const effective = async () => {
      const engine = await h.store.engineConfig();
      return {
        connector: engine.connectors.find((item) => item.name === 'sample-tools_api')?.enabled,
        skill: engine.skills.find((item) => item.name === 'package-canary')?.enabled,
      };
    };
    expect(await effective()).toEqual({ connector: true, skill: true });
    await h.store.setPluginEnabled(plugin.id, false);
    expect(await effective()).toEqual({ connector: undefined, skill: false });
    const listed = await h.store.list();
    expect(listed.connectors.find((item) => item.pluginId)?.enabled).toBe(true);
    expect(listed.skills.find((item) => item.pluginId)?.enabled).toBe(true);
    await h.store.setPluginEnabled(plugin.id, true);
    await h.store.update(plugin.connectors[0] as string, { enabled: false });
    await h.store.setSkillEnabled(plugin.skills[0] as string, false);
    expect(await effective()).toEqual({ connector: false, skill: false });
    await h.store.update(plugin.connectors[0] as string, { enabled: true });
    expect(await effective()).toEqual({ connector: true, skill: false });
  });

  it('升级：不带 replace 报冲突；带了换新版本，保留已填输入与各项开关，新项默认打开；失败不动旧版本', async () => {
    const h = await registry();
    const { plugin: v1 } = await h.store.installPlugin(fixture('wevir-plugin'), {
      inputs: { TOKEN: SECRET, REGION: 'eu' },
    });
    await h.store.update(v1.connectors[0] as string, { enabled: false });
    await h.store.setSkillEnabled(v1.skills[0] as string, false);
    await h.store.setPluginEnabled(v1.id, false);
    const next = copyFixture('wevir-plugin', (manifest) => {
      manifest.version = '1.1.0';
      manifest.inputs = [{ key: 'TOKEN', label: 'API token', secret: true, required: true }];
      manifest.connectors = {
        api: {
          transport: 'stdio',
          command: 'node',
          args: [`\${pluginDir}/server/mcp.mjs`],
          env: { PACKAGE_TOKEN: `\${input:TOKEN}` },
        },
      };
    });
    mkdirSync(join(next, 'skills', 'package-extra'));
    writeFileSync(
      join(next, 'skills', 'package-extra', 'SKILL.md'),
      '---\nname: package-extra\ndescription: Added in 1.1.0\n---\n',
    );
    await expect(h.store.installPlugin(next)).rejects.toThrow('already installed');
    const { plugin: v2 } = await h.store.installPlugin(next, { replace: true });
    expect(v2).toMatchObject({
      version: '1.1.0',
      enabled: false,
      inputs: [{ key: 'TOKEN', label: 'API token', set: true }],
      connectors: v1.connectors,
    });
    expect(v2.skills[0]).toBe(v1.skills[0]);
    const list = await h.store.list();
    expect(list.connectors.find((item) => item.pluginId)?.enabled).toBe(false);
    expect(
      list.skills.filter((item) => item.pluginId).map((item) => [item.name, item.enabled]),
    ).toEqual([
      ['package-canary', false],
      ['package-extra', true],
    ]);
    const dir = join(h.store.packagesRoot, 'sample-tools');
    expect(existsSync(join(dir, 'skills', 'package-extra', 'SKILL.md'))).toBe(true);
    const broken = copyFixture('wevir-plugin', (manifest) => {
      manifest.version = '2.0.0';
    });
    writeFileSync(join(broken, 'skills', 'package-canary', 'SKILL.md'), '---\nname: x\n---\n');
    await expect(h.store.installPlugin(broken, { replace: true })).rejects.toThrow();
    expect((await h.store.list()).plugins?.[0]?.version).toBe('1.1.0');
    expect(existsSync(join(dir, 'skills', 'package-extra', 'SKILL.md'))).toBe(true);
    expect(readdirSync(h.store.dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('卸载清掉安装目录与注册表；插件里的项不能单独删除或改配置', async () => {
    const h = await registry();
    const { plugin } = await h.store.installPlugin(fixture('wevir-plugin'));
    const connectorId = plugin.connectors[0] as string;
    const skillId = plugin.skills[0] as string;
    await expect(h.store.removeConnector(connectorId)).rejects.toThrow('remove the plugin');
    await expect(h.store.removeSkill(skillId)).rejects.toThrow('remove the plugin');
    await expect(h.store.update(connectorId, { name: 'renamed' })).rejects.toThrow('only enabled');
    await expect(
      h.store.update(connectorId, { config: { transport: 'stdio', command: 'other' } }),
    ).rejects.toThrow('only enabled');
    await h.store.removePlugin(plugin.id);
    expect(existsSync(join(h.store.packagesRoot, plugin.id))).toBe(false);
    expect(await h.store.list()).toEqual({ connectors: [], skills: [], plugins: [] });
    expect(readFileSync(join(h.home, 'plugins', 'registry.json'), 'utf8')).not.toContain(
      'sample-tools',
    );
    expect(readdirSync(h.store.dir).filter((name) => name.startsWith('.'))).toEqual([]);
    await expect(h.store.removePlugin(plugin.id)).rejects.toThrow('Plugin not found');
  });

  it('名字冲突：skill 名与已装的冲突时说出是哪个；引擎里的连接器名与散装的互斥', async () => {
    const h = await registry();
    const loose = join(temp(), 'loose', 'package-canary');
    mkdirSync(loose, { recursive: true });
    writeFileSync(join(loose, 'SKILL.md'), '---\nname: package-canary\ndescription: Loose\n---\n');
    await h.store.install(loose);
    await expect(h.store.installPlugin(fixture('wevir-plugin'))).rejects.toThrow(
      'Skill "package-canary" conflicts',
    );
    const other = copyFixture('wevir-plugin', (manifest) => {
      manifest.skills = './none';
    });
    await h.store.add('sample-tools_api', { transport: 'stdio', command: 'node' });
    await expect(h.store.installPlugin(other)).rejects.toThrow('"sample-tools_api" conflicts');
    expect(existsSync(join(h.store.packagesRoot, 'sample-tools'))).toBe(false);
    const h2 = await registry('home2');
    await h2.store.installPlugin(other);
    await expect(
      h2.store.add('sample-tools_api', { transport: 'stdio', command: 'node' }),
    ).rejects.toThrow('already exists');
  });

  it('导入 Claude 包：id 取清单 name，CLAUDE_PLUGIN_ROOT 换成安装目录，commands / hooks 报为已忽略', async () => {
    const h = await registry();
    const { plugin, ignored } = await h.store.installPlugin(fixture('claude-plugin'));
    expect(plugin).toMatchObject({
      id: 'claude-sample',
      name: 'Claude_Sample',
      version: '2.0.0',
      source: 'claude',
      author: { name: 'Fixture Author', url: 'https://example.com' },
      homepage: 'https://example.com/claude-sample',
      inputs: [],
    });
    expect(ignored).toEqual(['commands', 'hooks']);
    const list = await h.store.list();
    expect(list.connectors[0]).toMatchObject({
      name: 'claude-sample_files',
      config: { command: `\${pluginDir}/bin/server`, env: { FILES_KEY: true } },
    });
    expect(list.skills.map((item) => item.name)).toEqual(['claude-canary']);
    const dir = join(h.store.packagesRoot, 'claude-sample');
    expect((await h.store.engineConfig()).connectors[0]?.config).toMatchObject({
      command: `${dir}/bin/server`,
      args: ['--root', `${dir}/data`],
      env: { FILES_KEY: 'claude-env-value' },
    });
  });

  it('导入 Codex 包：显示名、作者、主页与图标取 interface，PLUGIN_ROOT 换成安装目录，apps 报为已忽略', async () => {
    const h = await registry();
    const { plugin, ignored } = await h.store.installPlugin(fixture('codex-plugin'));
    expect(plugin).toMatchObject({
      id: 'codex-sample',
      name: 'Codex Sample',
      version: '0.3.1',
      source: 'codex',
      author: { name: 'Fixture Developer' },
      homepage: 'https://example.com/codex-sample',
    });
    expect(plugin.iconUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(ignored).toEqual(['apps']);
    const dir = join(h.store.packagesRoot, 'codex-sample');
    expect((await h.store.engineConfig()).connectors).toEqual([
      expect.objectContaining({
        name: 'codex-sample_search',
        config: expect.objectContaining({ args: [`${dir}/search.py`] }),
      }),
    ]);
  });

  it.each([
    [
      '清单不合法',
      (m: Record<string, unknown>) => {
        m.id = 'Bad';
      },
      'wevir-plugin.json at id',
    ],
    [
      'homepage 不是地址',
      (m: Record<string, unknown>) => {
        m.homepage = 'not a url';
      },
      'wevir-plugin.json at homepage',
    ],
    [
      'author.url 不是地址',
      (m: Record<string, unknown>) => {
        m.author = { name: 'Sample', url: 'not a url' };
      },
      'wevir-plugin.json at author.url',
    ],
    [
      '行内 http 连接器的 url 不是地址',
      (m: Record<string, unknown>) => {
        m.connectors = { api: { transport: 'http', url: 'not a url' } };
      },
      'wevir-plugin.json at connectors',
    ],
    [
      '引用未声明的输入项',
      (m: Record<string, unknown>) => {
        m.inputs = [];
      },
      'undeclared input "REGION"',
    ],
    [
      'command 里用输入项',
      (m: Record<string, unknown>) => {
        m.connectors = { api: { transport: 'stdio', command: `\${input:TOKEN}` } };
      },
      'inputs can only be used',
    ],
    [
      'http 连接器用 pluginDir',
      (m: Record<string, unknown>) => {
        m.connectors = { api: { transport: 'http', url: `https://example.com/\${pluginDir}` } };
      },
      'only available to stdio',
    ],
    [
      '连接器文件不存在',
      (m: Record<string, unknown>) => {
        m.connectors = './connectors.json';
      },
      'Connector file not found',
    ],
    [
      '图标不存在',
      (m: Record<string, unknown>) => {
        m.icon = './missing.png';
      },
      'icon not found',
    ],
  ])('拒绝：%s', async (_name, edit, message) => {
    const h = await registry();
    await expect(h.store.installPlugin(copyFixture('wevir-plugin', edit))).rejects.toThrow(message);
    expect(await h.store.list()).toEqual({ connectors: [], skills: [], plugins: [] });
    expect(readdirSync(h.store.packagesRoot)).toEqual([]);
  });

  it('拒绝过大的图标、不是插件的文件夹、单个 SKILL.md 与危险 ZIP，失败不留下目录', async () => {
    const h = await registry();
    const big = copyFixture('wevir-plugin');
    writeFileSync(join(big, 'icon.svg'), 'x'.repeat(128 * 1024 + 1));
    await expect(h.store.installPlugin(big)).rejects.toThrow('128 KiB');
    const plain = join(temp(), 'plain');
    mkdirSync(plain);
    await expect(h.store.installPlugin(plain)).rejects.toThrow('Not a plugin package');
    await expect(
      h.store.installPlugin(join(fixture('wevir-plugin'), 'skills', 'package-canary', 'SKILL.md')),
    ).rejects.toThrow('plugin folder or ZIP');
    const bad = join(temp(), 'bad.zip');
    writeFileSync(bad, zip([{ name: '../escape/wevir-plugin.json', data: '{}' }]));
    await expect(h.store.installPlugin(bad)).rejects.toThrow();
    expect(readdirSync(h.store.packagesRoot)).toEqual([]);
    expect(readdirSync(h.store.dir).filter((name) => name.startsWith('.'))).toEqual([]);
  });
});

describe('plugin.* RPC + echo', () => {
  it('hello 声明 plugin_packages；安装、填输入、开关都发 plugins.changed，echo 收到展开后的启用项', async () => {
    const home = join(temp(), 'host');
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
    expect(hello.result.features).toMatchObject({ plugins: true, plugin_packages: true });
    let changes = 0;
    client.ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).method === 'plugins.changed') changes++;
    });
    const { plugin, ignored } = await client.request('plugin.install', {
      path: fixture('wevir-plugin'),
    });
    expect(ignored).toEqual([]);
    await expect(
      client.request('plugin.install', { path: fixture('wevir-plugin') }),
    ).rejects.toMatchObject({ code: -32602 });
    const { plugin: filled } = await client.request('plugin.setInputs', {
      id: plugin.id,
      values: { TOKEN: SECRET },
    });
    expect(filled.inputs[0]?.set).toBe(true);
    const list: PluginsList = await client.request('plugins.list', {});
    expect(list.plugins?.map((item) => item.id)).toEqual(['sample-tools']);
    expect(JSON.stringify(list)).not.toContain(SECRET);
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
    const reply = async (text: string) => {
      const { turnId } = await client.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text }],
      });
      await client.until(
        () =>
          client
            .events(subscriptionId)
            .find((item) => item.type === 'turn.finished' && item.payload.turnId === turnId),
        'turn.finished',
      );
      const last = client
        .events(subscriptionId)
        .filter((item) => item.type === 'assistant.message')
        .at(-1);
      return last?.type === 'assistant.message' ? last.payload.text : '';
    };
    expect(await reply('list plugins')).toContain('Connectors: sample-tools_api');
    await client.request('plugin.setEnabled', { id: plugin.id, enabled: false });
    const off = await reply('list plugins again');
    expect(off).not.toContain('sample-tools_api');
    expect(off).not.toContain('package-canary');
    await client.request('plugin.remove', { id: plugin.id });
    expect((await client.request('plugins.list', {})).plugins).toEqual([]);
    await client.until(() => (changes >= 3 ? true : undefined), 'plugins.changed');
  });
});
