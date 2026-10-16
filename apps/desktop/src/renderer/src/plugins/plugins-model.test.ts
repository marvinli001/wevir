import type { Connector, HostFeatures, Plugin, PluginsList, Skill } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  byName,
  connectorState,
  defaultTab,
  groupSkills,
  missingRequiredInputs,
  originName,
  pluginItems,
  pluginsAvailability,
  pluginsById,
  replaceConnector,
  replacePlugin,
  replaceSkill,
  resolveTab,
  skillBody,
  skillProject,
  skillSummary,
  visibleTabs,
} from './plugins-model';

const connector = (patch: Partial<Connector> = {}): Connector => ({
  id: 'con_1',
  name: 'sample',
  config: { transport: 'stdio', command: 'node' },
  enabled: true,
  ...patch,
});
const skill = (patch: Partial<Skill> = {}): Skill => ({
  id: 'skl_1',
  name: 'sample',
  description: 'A sample skill',
  source: 'wevir',
  path: '/data/plugins/skills/sample/SKILL.md',
  enabled: true,
  ...patch,
});
const plugin = (patch: Partial<Plugin> = {}): Plugin => ({
  id: 'sample-plugin',
  name: 'Sample plugin',
  version: '1.0.0',
  source: 'wevir',
  enabled: true,
  path: '/data/plugins/packages/sample-plugin',
  inputs: [],
  connectors: [],
  skills: [],
  ...patch,
});

describe('功能门控与分段', () => {
  const none: HostFeatures = {};
  const plain: HostFeatures = { plugins: true };
  const packages: HostFeatures = { plugins: true, plugin_packages: true };

  it('还没连上是 pending，没有 plugins 功能是 unsupported（左栏不显示入口）', () => {
    expect(pluginsAvailability(undefined)).toBe('pending');
    expect(pluginsAvailability(none)).toBe('unsupported');
    expect(pluginsAvailability({ plugin_packages: true })).toBe('unsupported');
    expect(pluginsAvailability(plain)).toBe('ready');
    expect(pluginsAvailability(packages)).toBe('ready');
  });

  it('没有 plugin_packages 的 Host（0.41.0）没有“插件”分段，默认分段是“连接器”', () => {
    expect(visibleTabs(packages)).toEqual(['plugins', 'connectors', 'skills']);
    expect(visibleTabs(plain)).toEqual(['connectors', 'skills']);
    expect(defaultTab(packages)).toBe('plugins');
    expect(defaultTab(plain)).toBe('connectors');
  });

  it('URL 里的分段：认得且支持就用，认不出或不支持转到默认分段', () => {
    expect(resolveTab('skills', packages)).toEqual({ tab: 'skills', redirect: false });
    expect(resolveTab('plugins', packages)).toEqual({ tab: 'plugins', redirect: false });
    expect(resolveTab(undefined, packages)).toEqual({ tab: 'plugins', redirect: true });
    expect(resolveTab('market', packages)).toEqual({ tab: 'plugins', redirect: true });
    expect(resolveTab('plugins', plain)).toEqual({ tab: 'connectors', redirect: true });
    expect(resolveTab('skills', plain)).toEqual({ tab: 'skills', redirect: false });
  });
});

describe('connectorState', () => {
  it.each([
    [{ status: 'connected' }, 'connected', 'success', false],
    [{ status: 'starting' }, 'starting', 'accent', true],
    [{ status: 'failed' }, 'failed', 'danger', false],
    [{ status: 'cancelled' }, 'failed', 'danger', false],
    [{ status: 'authenticationRequired' }, 'authRequired', 'warning', false],
    [{ status: 'disabled' }, 'disabled', 'neutral', false],
    [{ status: 'notStarted' }, 'idle', 'neutral', false],
    [{}, 'idle', 'neutral', false],
    [{ status: 'something-new' }, 'idle', 'neutral', false],
  ] as const)('引擎的状态 %j → %s', (patch, key, tone, pulse) => {
    expect(connectorState(connector(patch))).toEqual({ key, tone, pulse });
  });

  it('连接器自己或所属插件关着是“已关闭”，不管引擎还报着什么', () => {
    expect(connectorState(connector({ enabled: false, status: 'connected' })).key).toBe('disabled');
    expect(connectorState(connector({ status: 'connected' }), plugin({ enabled: false })).key).toBe(
      'disabled',
    );
    expect(connectorState(connector({ status: 'connected' }), plugin()).key).toBe('connected');
  });

  it('缺必填输入项的连接器不会被引擎启动，状态写“缺少输入项”', () => {
    expect(connectorState(connector({ missingInputs: ['TOKEN'], status: 'connected' })).key).toBe(
      'missingInputs',
    );
    expect(connectorState(connector({ missingInputs: [] })).key).toBe('idle');
    // 关着的优先。
    expect(connectorState(connector({ enabled: false, missingInputs: ['TOKEN'] })).key).toBe(
      'disabled',
    );
  });
});

describe('Skills', () => {
  const skills = [
    skill({ id: 'a', name: 'zeta' }),
    skill({
      id: 'b',
      name: 'alpha',
      source: 'user',
      path: '/home/u/.agents/skills/alpha/SKILL.md',
    }),
    skill({ id: 'c', name: 'skill10' }),
    skill({ id: 'd', name: 'skill2' }),
    skill({
      id: 'e',
      name: 'beta',
      source: 'project',
      path: '/work/app/.agents/skills/beta/SKILL.md',
    }),
    skill({
      id: 'f',
      name: 'alpha',
      pluginId: 'p',
      path: '/data/plugins/packages/p/skills/alpha/SKILL.md',
    }),
  ];

  it('分成 Wevir（含插件里的）、我的、项目三组，组内按名字排（数字按大小），同名按路径', () => {
    const groups = groupSkills(skills);
    expect(groups.wevir.map((item) => item.id)).toEqual(['f', 'd', 'c', 'a']);
    expect(groups.user.map((item) => item.id)).toEqual(['b']);
    expect(groups.project.map((item) => item.id)).toEqual(['e']);
    expect(groupSkills([])).toEqual({ wevir: [], user: [], project: [] });
  });

  it('byName 不改原数组', () => {
    const input = [{ name: 'b' }, { name: 'a' }];
    expect(byName(input)).toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(input[0]?.name).toBe('b');
  });

  it('行里的描述：短描述优先，折成一行', () => {
    expect(skillSummary({ description: 'line one\n  line two' })).toBe('line one line two');
    expect(skillSummary({ shortDescription: 'short', description: 'long' })).toBe('short');
  });

  it('项目 Skills 的项目文件夹名取自路径，认不出时没有', () => {
    expect(skillProject({ path: '/work/app/.agents/skills/beta/SKILL.md' })).toBe('app');
    expect(skillProject({ path: '/work/app/.codex/skills/x/y/SKILL.md' })).toBe('app');
    expect(skillProject({ path: 'C:\\work\\app\\.agents\\skills\\beta\\SKILL.md' })).toBe('app');
    expect(skillProject({ path: '/home/u/.agents/skills/alpha/SKILL.md' })).toBe('u');
    expect(skillProject({ path: '/data/plugins/skills/x/SKILL.md' })).toBeUndefined();
  });

  it('预览去掉 frontmatter，没有时原样', () => {
    expect(skillBody('---\nname: a\ndescription: b\n---\n\n# Title\n\ntext')).toBe(
      '# Title\n\ntext',
    );
    expect(skillBody('---\r\nname: a\r\n---\r\nbody')).toBe('body');
    expect(skillBody('\ufeff---\nname: a\n---\nbody')).toBe('body');
    expect(skillBody('# Title\n---\nnot frontmatter')).toBe('# Title\n---\nnot frontmatter');
    expect(skillBody('---\nname: a\n---')).toBe('');
    // 没有收尾的 --- 时不是 frontmatter。
    expect(skillBody('---\nname: a\nbody')).toBe('---\nname: a\nbody');
  });
});

describe('插件', () => {
  it('必填又没填的输入项', () => {
    const input = (key: string, patch: Partial<Plugin['inputs'][number]>) => ({
      key,
      label: key,
      secret: false,
      required: false,
      set: false,
      ...patch,
    });
    const target = plugin({
      inputs: [
        input('A', { required: true }),
        input('B', { required: true, set: true }),
        input('C', {}),
      ],
    });
    expect(missingRequiredInputs(target).map((item) => item.key)).toEqual(['A']);
    expect(missingRequiredInputs(plugin())).toEqual([]);
  });

  it('插件包含的各项按插件记的 ID 找，各自按名字排，找不到的跳过', () => {
    const target = plugin({ connectors: ['c2', 'c1', 'gone'], skills: ['s1'] });
    const items = pluginItems(target, {
      connectors: [
        connector({ id: 'c1', name: 'b-api' }),
        connector({ id: 'c2', name: 'a-api' }),
        connector({ id: 'c3', name: 'loose' }),
      ],
      skills: [skill({ id: 's1' }), skill({ id: 's2', name: 'other' })],
    });
    expect(items.connectors.map((item) => item.id)).toEqual(['c2', 'c1']);
    expect(items.skills.map((item) => item.id)).toEqual(['s1']);
  });

  it('“来自”写插件的显示名，插件不在列表里退回 ID，散装的没有', () => {
    const plugins = pluginsById([plugin()]);
    expect(originName('sample-plugin', plugins)).toBe('Sample plugin');
    expect(originName('gone', plugins)).toBe('gone');
    expect(originName(undefined, plugins)).toBeUndefined();
  });
});

describe('本地合并', () => {
  const list = (): PluginsList => ({
    connectors: [connector({ id: 'c1' }), connector({ id: 'c2', name: 'other' })],
    skills: [skill({ id: 's1' }), skill({ id: 's2', name: 'other' })],
    plugins: [plugin({ id: 'p1' }), plugin({ id: 'p2', name: 'Other' })],
  });

  it('方法的结果换进列表里同 ID 的那一项，别的项与顺序不变', () => {
    const current = list();
    const next = replaceConnector(current, connector({ id: 'c1', enabled: false }));
    expect(next.connectors.map((item) => [item.id, item.enabled])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
    expect(next.skills).toBe(current.skills);
    expect(
      replaceSkill(current, skill({ id: 's2', enabled: false })).skills.map((s) => s.enabled),
    ).toEqual([true, false]);
    expect(
      replacePlugin(current, plugin({ id: 'p2', enabled: false })).plugins?.map((p) => p.enabled),
    ).toEqual([true, false]);
  });

  it('不在列表里的 ID 不新增，没有 plugins 的老 Host 也不出错', () => {
    expect(replaceConnector(list(), connector({ id: 'gone' })).connectors).toHaveLength(2);
    expect(replacePlugin({ connectors: [], skills: [] }, plugin()).plugins).toEqual([]);
  });
});
