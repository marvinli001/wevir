import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApprovalRule, Connector, Guardrail, RepoHook, Skill } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { discoverRuleFiles } from '../rule-files.js';
import { useTempDir } from '../test-utils.js';
import {
  FileHashCache,
  fingerprintOf,
  layerHash,
  ProfileCollector,
  type ProfileSources,
  sha256,
} from './profile.js';

const tempDir = useTempDir();

function setup(overrides: Partial<ProfileSources> = {}) {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const project = join(root, 'project');
  const prompts = join(root, 'prompts');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(project, '.git'), { recursive: true });
  mkdirSync(join(prompts, 'output-styles'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'user rules');
  writeFileSync(join(project, 'AGENTS.md'), 'Run pnpm test.');
  writeFileSync(join(prompts, 'base.md'), 'You are Wevir.');
  writeFileSync(join(prompts, 'README.md'), 'how prompts are written');
  writeFileSync(join(prompts, 'output-styles', 'concise.md'), 'Be brief.');
  const skillDir = join(project, '.agents', 'skills', 'release');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: release\n---\nShip it.');
  writeFileSync(join(skillDir, 'notes.txt'), 'extra');
  const skills: Skill[] = [
    {
      id: 'ext_1',
      name: 'release',
      description: 'release',
      source: 'project',
      path: join(skillDir, 'SKILL.md'),
      enabled: true,
    },
    {
      id: 'ext_2',
      name: 'elsewhere',
      description: 'other project',
      source: 'project',
      path: join(root, 'other', '.agents', 'skills', 'elsewhere', 'SKILL.md'),
      enabled: true,
    },
  ];
  const settings = { agentInstructions: 'Answer in English.', outputStyle: 'concise' };
  const rules: ApprovalRule[] = [
    {
      id: 'arl_1',
      kind: 'command_prefix',
      prefix: ['git', 'status'],
      source: 'approval',
      createdAt: '2026-10-21T00:00:00.000Z',
      useCount: 3,
    },
  ];
  const connectors: Connector[] = [
    {
      id: 'con_1',
      name: 'github',
      enabled: true,
      config: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'github-mcp'],
        env: { GITHUB_TOKEN: true },
      },
    },
    {
      id: 'con_2',
      name: 'search',
      enabled: true,
      config: {
        transport: 'http',
        url: 'https://user:pw@search.example.com/mcp?key=sk-secret-123',
        headers: { Authorization: true },
      },
    },
    {
      id: 'con_3',
      name: 'other-project',
      enabled: true,
      workspaceId: 'ws_other',
      config: { transport: 'stdio', command: 'other' },
    },
  ];
  const sources: ProfileSources = {
    promptsDir: prompts,
    userHome: home,
    ruleFiles: (cwd) => discoverRuleFiles({ cwd, home, env: {} }),
    settings: () => settings,
    skills: async () => skills,
    approvalRules: () => rules,
    connectors: () => connectors,
    plugins: () => [{ id: 'kit', name: 'Kit', version: '1.2.0', enabled: true }],
    ...overrides,
  };
  const collector = new ProfileCollector(sources);
  const scope = { workspaceId: 'ws_1', rootPath: project };
  return { root, home, project, prompts, skillDir, settings, rules, connectors, collector, scope };
}

const layer = (profile: { layers: { key: string; items: unknown[] }[] }, key: string) =>
  profile.layers.find((item) => item.key === key);

describe('档案采集', () => {
  it('八层齐全；同样的配置指纹稳定，与条目先后无关', async () => {
    const env = setup();
    const first = await env.collector.collect(env.scope);
    const second = await new ProfileCollector({
      promptsDir: env.prompts,
      userHome: env.home,
      ruleFiles: (cwd) => discoverRuleFiles({ cwd, home: env.home, env: {} }),
      settings: () => env.settings,
      skills: async () => [],
    }).collect(env.scope);
    expect(first.layers.map((item) => item.key)).toEqual([
      'system',
      'rules',
      'instructions',
      'memory',
      'skills',
      'roles',
      'guardrails',
      'connectors',
    ]);
    expect((await env.collector.collect(env.scope)).fingerprint).toBe(first.fingerprint);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    // 层散列只看 id、范围与散列：换显示名与顺序不变。
    const items = layer(first, 'rules')?.items as Parameters<typeof layerHash>[0];
    expect(layerHash([...items].reverse().map((item) => ({ ...item, label: 'x' })))).toBe(
      layerHash(items),
    );
    expect(fingerprintOf([...first.layers].reverse())).toBe(first.fingerprint);
  });

  it('各层的条目：系统提示不含 README，规则文件分全局与项目，技能只算本项目的', async () => {
    const env = setup();
    const profile = await env.collector.collect(env.scope);
    expect(layer(profile, 'system')?.items).toEqual([
      expect.objectContaining({ id: 'base.md', scope: 'global', text: true }),
      expect.objectContaining({ id: 'output-styles/concise.md' }),
    ]);
    expect(layer(profile, 'rules')?.items).toEqual([
      expect.objectContaining({ label: '~/.codex/AGENTS.md', scope: 'global' }),
      expect.objectContaining({
        label: 'AGENTS.md',
        scope: 'project',
        hash: sha256('Run pnpm test.'),
      }),
    ]);
    expect(layer(profile, 'instructions')?.items).toEqual([
      expect.objectContaining({ id: 'agentInstructions', text: true }),
      expect.objectContaining({ id: 'outputStyle', detail: 'concise' }),
    ]);
    const skills = layer(profile, 'skills')?.items;
    expect(skills).toEqual([
      expect.objectContaining({
        label: 'release',
        scope: 'project',
        path: env.skillDir,
        text: true,
        textHash: sha256('---\nname: release\n---\nShip it.'),
      }),
    ]);
    expect(layer(profile, 'guardrails')?.items).toEqual([
      expect.objectContaining({ label: 'git status', scope: 'global' }),
    ]);
    // 全局档案：只有用户级规则文件，没有项目技能。
    const global = await env.collector.collect({});
    expect(layer(global, 'rules')?.items).toHaveLength(1);
    expect(layer(global, 'skills')?.items).toEqual([]);
    expect(global.fingerprint).not.toBe(profile.fingerprint);
  });

  it('改动被看出来：规则文件、技能目录里的文件、设置与审批规则各自只改自己那层', async () => {
    const env = setup();
    const before = await env.collector.collect(env.scope);
    const hashes = (profile: typeof before) =>
      Object.fromEntries(profile.layers.map((item) => [item.key, item.hash]));

    writeFileSync(join(env.project, 'AGENTS.md'), 'Run pnpm test and lint.');
    writeFileSync(join(env.skillDir, 'notes.txt'), 'changed');
    env.settings.agentInstructions = 'Answer in French.';
    env.rules[0] = { ...env.rules[0], useCount: 9 } as ApprovalRule;
    const after = await env.collector.collect(env.scope);
    const a = hashes(before);
    const b = hashes(after);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(Object.keys(a).filter((key) => a[key] !== b[key])).toEqual([
      'rules',
      'instructions',
      'skills',
    ]);
  });

  it('护栏层：启用的护栏规则与启用、内容没变的仓库 hooks，命中次数与规则名不进散列', async () => {
    const guardrail = (id: string, patch: Partial<Guardrail>): Guardrail => ({
      id: id as Guardrail['id'],
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
      enabled: true,
      revision: 1,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
      hits: 0,
      ...patch,
    });
    const hook = (id: string, status: string): RepoHook => ({
      id,
      file: '.codex/hooks.json',
      event: 'PreToolUse',
      handler: 'command',
      command: `./scripts/${id}.sh`,
      hash: `sha256:${id}`,
      status,
    });
    const guardrails: Guardrail[] = [
      guardrail('grd_1', {}),
      guardrail('grd_2', {
        workspaceId: 'ws_1' as Guardrail['workspaceId'],
        rule: { kind: 'stop_check', command: 'pnpm test' },
      }),
      guardrail('grd_3', { enabled: false, rule: { kind: 'protected_path', glob: '.env' } }),
    ];
    const hooks = [hook('a', 'enabled'), hook('b', 'disabled'), hook('c', 'changed')];
    const env = setup({ guardrails: () => guardrails, repoHooks: () => hooks });
    const profile = await env.collector.collect(env.scope);
    expect(layer(profile, 'guardrails')?.items).toEqual([
      expect.objectContaining({
        id: 'guardrail:global:grd_1',
        label: 'rm -rf',
        scope: 'global',
        detail: 'forbidden_command',
      }),
      expect.objectContaining({
        id: 'guardrail:project:grd_2',
        label: 'pnpm test',
        scope: 'project',
        detail: 'stop_check',
      }),
      expect.objectContaining({
        id: 'repoHook:a',
        label: '.codex/hooks.json · PreToolUse · ./scripts/a.sh',
        scope: 'project',
        path: join(env.project, '.codex/hooks.json'),
        detail: 'repoHook',
      }),
      expect.objectContaining({ id: expect.stringMatching(/^approval:/), detail: 'approval' }),
    ]);
    const hash = { hash: profile.layers.find((item) => item.key === 'guardrails')?.hash };
    // 命中与改名不改散列；停用、改规则、启用仓库 hook 都改。
    guardrails[0] = { ...(guardrails[0] as Guardrail), hits: 7, name: 'no rm' };
    const renamed = await env.collector.collect(env.scope);
    expect(layer(renamed, 'guardrails')).toMatchObject({ hash: hash.hash });
    expect(layer(renamed, 'guardrails')?.items[0]).toMatchObject({ label: 'no rm' });
    guardrails[0] = { ...(guardrails[0] as Guardrail), enabled: false };
    const disabled = await env.collector.collect(env.scope);
    expect(layer(disabled, 'guardrails')).not.toMatchObject({ hash: hash.hash });
    hooks[1] = hook('b', 'enabled');
    const enabled = await env.collector.collect(env.scope);
    expect(
      layer(enabled, 'guardrails')?.items.map((item) => (item as { id: string }).id),
    ).toContain('repoHook:b');
    // 全局档案没有仓库 hooks。
    const global = await env.collector.collect({});
    expect(
      layer(global, 'guardrails')?.items.some((item) =>
        (item as { id: string }).id.startsWith('repoHook:'),
      ),
    ).toBe(false);
  });

  it('连接器只记名称、命令与去掉查询串的地址：密钥与参数不进条目，键名与参数只影响散列', async () => {
    const env = setup();
    const profile = await env.collector.collect(env.scope);
    const items = layer(profile, 'connectors')?.items;
    expect(items).toEqual([
      expect.objectContaining({ id: 'connector:github', detail: 'npx', scope: 'global' }),
      expect.objectContaining({
        id: 'connector:search',
        detail: 'https://search.example.com/mcp',
      }),
      expect.objectContaining({ id: 'plugin:kit', label: 'Kit', detail: '1.2.0' }),
    ]);
    const manifest = JSON.stringify(profile.layers);
    for (const secret of [
      'sk-secret-123',
      'user:pw',
      'GITHUB_TOKEN',
      'Authorization',
      'github-mcp',
    ]) {
      expect(manifest).not.toContain(secret);
    }
    expect([...profile.texts.values()].join('\n')).not.toContain('sk-secret');
    // 换了参数：散列变，条目里看不到参数。
    const config = env.connectors[0]?.config;
    if (config?.transport === 'stdio') config.args = ['-y', 'github-mcp@2'];
    const changed = await env.collector.collect(env.scope);
    expect(layer(changed, 'connectors')?.items[0]).not.toEqual(items?.[0]);
  });

  it('文本只交出一次：已存过的散列不再交，没变的文件不再读', async () => {
    const env = setup();
    const stored = new Set<string>();
    const known = (hash: string) => stored.has(hash);
    const first = await env.collector.collect(env.scope, known);
    expect(first.texts.get(sha256('Run pnpm test.'))).toBe('Run pnpm test.');
    for (const hash of first.texts.keys()) stored.add(hash);
    const second = await env.collector.collect(env.scope, known);
    expect(second.texts.size).toBe(0);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe('FileHashCache', () => {
  it('mtime 与大小没变、文本已存过时用缓存；变了重读', async () => {
    const file = join(tempDir(), 'a.md');
    writeFileSync(file, 'one');
    const cache = new FileHashCache();
    const first = await cache.read(file, () => true);
    expect(first).toEqual({ hash: sha256('one'), size: 3, text: 'one' });
    expect(await cache.read(file, () => true)).toEqual({ hash: sha256('one'), size: 3 });
    // 文本没存过：照样给正文。
    expect((await cache.read(file, () => false))?.text).toBe('one');
    writeFileSync(file, 'two');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await cache.read(file, () => true))?.hash).toBe(sha256('two'));
    expect(await cache.read(join(tempDir(), 'missing.md'), () => true)).toBeUndefined();
  });
});
