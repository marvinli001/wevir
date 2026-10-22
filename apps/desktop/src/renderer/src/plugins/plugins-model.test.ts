import type { Connector, HostFeatures, Plugin, PluginsList, Skill } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  byName,
  commandLine,
  conflictingNames,
  connectorState,
  defaultTab,
  groupSkills,
  landingTab,
  missingRequiredInputs,
  missingSecretKeys,
  needsSignIn,
  nothingInstalled,
  originName,
  pluginItems,
  pluginSignIn,
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
  const market: HostFeatures = { ...packages, plugin_market: true };

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

  it('有 plugin_market 时“市场”在最前，但默认分段仍是第一个已安装的分段', () => {
    expect(visibleTabs(market)).toEqual(['market', 'plugins', 'connectors', 'skills']);
    expect(defaultTab(market)).toBe('plugins');
  });

  it('URL 里的分段：认得且支持就用，认不出或不支持是 undefined（转回 /plugins）', () => {
    expect(resolveTab('skills', packages)).toBe('skills');
    expect(resolveTab('plugins', packages)).toBe('plugins');
    expect(resolveTab(undefined, packages)).toBeUndefined();
    expect(resolveTab('market', packages)).toBeUndefined();
    expect(resolveTab('market', market)).toBe('market');
    expect(resolveTab('plugins', plain)).toBeUndefined();
    expect(resolveTab('skills', plain)).toBe('skills');
  });

  it('/plugins 的落点：从没装过东西进市场，其余沿用上次的分段，没有记下的用默认分段', () => {
    const empty = { plugins: [], connectors: [], skills: [] };
    const some = { plugins: [], connectors: [connector()], skills: [] };
    expect(nothingInstalled(empty)).toBe(true);
    expect(nothingInstalled({ connectors: [], skills: [skill()] })).toBe(false);
    expect(landingTab(market, 'skills', empty)).toBe('market');
    expect(landingTab(market, 'skills', some)).toBe('skills');
    expect(landingTab(market, 'market', some)).toBe('market');
    expect(landingTab(market, undefined, some)).toBe('plugins');
    // 列表读不到时按装过东西处理；Host 没有市场时空列表也不去市场。
    expect(landingTab(market, undefined, undefined)).toBe('plugins');
    expect(landingTab(packages, 'market', empty)).toBe('plugins');
    expect(landingTab(plain, 'plugins', some)).toBe('connectors');
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

  it('OAuth 连接器没登录好时按 oauth.status，已登录的照引擎的状态', () => {
    const oauth = (status: NonNullable<Connector['oauth']>['status']) =>
      connector({ status: 'connected', oauth: { status } });
    expect(connectorState(oauth('required'))).toEqual({
      key: 'authRequired',
      tone: 'warning',
      pulse: false,
    });
    expect(connectorState(oauth('signing_in'))).toEqual({
      key: 'signingIn',
      tone: 'accent',
      pulse: true,
    });
    expect(connectorState(oauth('insufficient_scope')).key).toBe('insufficientScope');
    expect(connectorState(oauth('error')).key).toBe('signInFailed');
    expect(connectorState(oauth('signed_in')).key).toBe('connected');
    expect(connectorState(connector({ enabled: false, oauth: { status: 'required' } })).key).toBe(
      'disabled',
    );
  });

  it('要登录的：没登录、权限不够、上次失败；登录中与已登录的不算', () => {
    expect(needsSignIn(connector())).toBe(false);
    expect(needsSignIn(connector({ oauth: { status: 'required' } }))).toBe(true);
    expect(needsSignIn(connector({ oauth: { status: 'insufficient_scope' } }))).toBe(true);
    expect(needsSignIn(connector({ oauth: { status: 'error', error: 'denied' } }))).toBe(true);
    expect(needsSignIn(connector({ oauth: { status: 'signing_in' } }))).toBe(false);
    expect(needsSignIn(connector({ oauth: { status: 'signed_in' } }))).toBe(false);
  });

  it('插件里第一个要登录或正在登录的连接器；插件或连接器关着的不算', () => {
    const a = connector({ id: 'con_a', name: 'a', oauth: { status: 'signed_in' } });
    const b = connector({ id: 'con_b', name: 'b', oauth: { status: 'required' } });
    const c = connector({ id: 'con_c', name: 'c', oauth: { status: 'signing_in' } });
    const list = { connectors: [c, b, a], skills: [] };
    expect(pluginSignIn(plugin({ connectors: ['con_a', 'con_b', 'con_c'] }), list)).toBe(b);
    expect(pluginSignIn(plugin({ connectors: ['con_a', 'con_c'] }), list)).toBe(c);
    expect(pluginSignIn(plugin({ connectors: ['con_a'] }), list)).toBeUndefined();
    expect(pluginSignIn(plugin({ enabled: false, connectors: ['con_b'] }), list)).toBeUndefined();
    expect(
      pluginSignIn(plugin({ connectors: ['con_b'] }), {
        connectors: [{ ...b, enabled: false }],
        skills: [],
      }),
    ).toBeUndefined();
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

describe('连接器的范围与待填键（0.74.0）', () => {
  const list = [
    connector({ id: 'a', name: 'global-one' }),
    connector({ id: 'b', name: 'in-x', workspaceId: 'ws_x' }),
    connector({ id: 'c', name: 'in-y', workspaceId: 'ws_y' }),
  ];

  it('全局与所有连接器比，项目与全局及同一项目比，编辑时不算自己', () => {
    expect(conflictingNames(list, undefined)).toEqual(new Set(['global-one', 'in-x', 'in-y']));
    expect(conflictingNames(list, 'ws_x')).toEqual(new Set(['global-one', 'in-x']));
    expect(conflictingNames(list, 'ws_x', 'b')).toEqual(new Set(['global-one']));
  });

  it('只有散装连接器的 missingInputs 是待填的键', () => {
    expect(missingSecretKeys(connector({ missingInputs: ['TOKEN'] }))).toEqual(['TOKEN']);
    expect(missingSecretKeys(connector({ pluginId: 'p', missingInputs: ['KEY'] }))).toEqual([]);
    expect(missingSecretKeys(connector())).toEqual([]);
  });

  it('命令行带空白的参数加引号', () => {
    expect(commandLine('npx', ['-y', 'a b'])).toBe('npx -y "a b"');
  });
});
