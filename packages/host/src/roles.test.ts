import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeAgent, parseCodexAgent } from './external-agents.js';
import {
  BUILTIN_ROLES,
  parseRole,
  ROLE_DESCRIPTION_MAX,
  ROLE_INSTRUCTIONS_MAX_BYTES,
  RoleStore,
  roleAllowsTool,
  roleEngineTools,
} from './roles.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

const file = (front: string, body = 'Body.') => `---\n${front}\n---\n${body}\n`;
const tool = (name: string, readOnlyHint?: boolean) => ({
  name,
  annotations: readOnlyHint === undefined ? {} : { readOnlyHint },
});

describe('parseRole', () => {
  it('必填的描述、可选的模型 / 权限 / 工具，文件名当默认名字，正文是说明', () => {
    const role = parseRole(
      'user',
      'planner.md',
      file(
        [
          'description: Plans work',
          'provider: openai',
          'model: gpt-x',
          'reasoningEffort: high',
          'permissionMode: auto_review',
          'tools: wevir_session_list, mcp__wevir__wevir_show',
          'disallowedTools:',
          '  - browser_*',
        ].join('\n'),
        '  Plan first.  ',
      ),
    );
    expect(role).toEqual({
      name: 'planner',
      description: 'Plans work',
      source: 'user',
      providerId: 'openai',
      modelId: 'gpt-x',
      reasoningEffort: 'high',
      permissionMode: 'auto_review',
      tools: ['wevir_session_list', 'mcp__wevir__wevir_show'],
      disallowedTools: ['browser_*'],
      instructions: 'Plan first.',
    });
    expect(parseRole('user', 'x.md', file('name: other\ndescription: d'))).toMatchObject({
      name: 'other',
    });
  });

  it('不合规的给出原因', () => {
    const message = (text: string, name = 'x.md') => {
      const parsed = parseRole('user', name, text);
      return 'message' in parsed ? parsed.message : 'ok';
    };
    expect(message('no frontmatter')).toMatch(/frontmatter/);
    expect(message(file('description: [unclosed'))).toMatch(/invalid YAML/);
    expect(message(file('- a\n- b'))).toMatch(/mapping/);
    expect(message(file('foo: 1'))).toMatch(/description is required/);
    expect(message(file('description: d'), 'Bad Name.md')).toMatch(/name "Bad Name"/);
    expect(message(file(`description: ${'x'.repeat(ROLE_DESCRIPTION_MAX + 1)}`))).toMatch(
      /longer than/,
    );
    expect(message(file('description: d', 'x'.repeat(ROLE_INSTRUCTIONS_MAX_BYTES + 1)))).toMatch(
      /instructions are longer/,
    );
    expect(message(file('description: d\npermissionMode: root'))).toMatch(/permissionMode/);
    expect(message(file('description: d\nmodel: 3'))).toMatch(/model must be/);
    expect(message(file('description: d\ntools: 3'))).toMatch(/tools must be/);
  });
});

describe('roleAllowsTool', () => {
  it('没有角色都能用；tools 是白名单（名字、前缀、readonly），disallowedTools 先判断', () => {
    expect(roleAllowsTool(undefined, tool('anything'))).toBe(true);
    expect(roleAllowsTool({}, tool('anything'))).toBe(true);
    const readonly = { tools: ['readonly'] };
    expect(roleAllowsTool(readonly, tool('wevir_session_list', true))).toBe(true);
    expect(roleAllowsTool(readonly, tool('wevir_session_create', false))).toBe(false);
    expect(roleAllowsTool(readonly, tool('no_hint'))).toBe(false);
    const named = { tools: ['mcp__wevir__wevir_show', 'browser_*'] };
    expect(roleAllowsTool(named, tool('wevir_show'))).toBe(true);
    expect(roleAllowsTool(named, tool('browser_click'))).toBe(true);
    expect(roleAllowsTool(named, tool('wevir_share_file'))).toBe(false);
    const denied = { tools: ['readonly'], disallowedTools: ['lsp_*'] };
    expect(roleAllowsTool(denied, tool('lsp_hover', true))).toBe(false);
    expect(roleAllowsTool(denied, tool('wevir_models', true))).toBe(true);
    expect(roleAllowsTool({ disallowedTools: ['wevir_session_*'] }, tool('wevir_models'))).toBe(
      true,
    );
  });

  it('内置角色：explorer / reviewer 只许只读，worker 不能开或指挥别的会话', () => {
    const byName = Object.fromEntries(BUILTIN_ROLES.map((role) => [role.name, role]));
    for (const name of ['advisor', 'explorer', 'planner', 'reviewer']) {
      expect(byName[name]?.tools).toEqual(['readonly']);
      expect(byName[name]?.permissionMode).toBe('on_request');
      // 只读角色不写跨会话记忆。
      expect(roleAllowsTool(byName[name], tool('wevir_memory_save', true))).toBe(false);
      expect(roleAllowsTool(byName[name], tool('wevir_session_read', true))).toBe(true);
    }
    const worker = byName.worker;
    expect(roleAllowsTool(worker, tool('wevir_session_create'))).toBe(false);
    expect(roleAllowsTool(worker, tool('wevir_plugin_install'))).toBe(false);
    expect(roleAllowsTool(worker, tool('wevir_session_progress', true))).toBe(true);
    expect(roleAllowsTool(worker, tool('browser_click'))).toBe(true);
  });
});

describe('RoleStore', () => {
  it('内置 < 用户 < 项目；没有目录也行；非 .md 与隐藏文件不读', async () => {
    const root = tempDir();
    const dir = join(root, 'roles');
    const project = join(root, 'project');
    const store = new RoleStore({ dir });
    // 目录都不存在：只有内置的。
    expect((await store.list(project)).roles.map((role) => role.name)).toEqual([
      'advisor',
      'explorer',
      'planner',
      'reviewer',
      'worker',
    ]);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(project, '.wevir', 'roles'), { recursive: true });
    writeFileSync(join(dir, 'worker.md'), file('description: User worker'));
    writeFileSync(join(dir, 'notes.txt'), file('description: not markdown'));
    writeFileSync(join(dir, '.hidden.md'), file('description: hidden'));
    writeFileSync(
      join(project, '.wevir', 'roles', 'worker.md'),
      file('description: Project worker'),
    );
    writeFileSync(join(project, '.wevir', 'roles', 'docs.md'), file('description: Docs writer'));
    const listed = await store.list(project);
    expect(listed.problems).toEqual([]);
    expect(listed.roles.map((role) => `${role.name}:${role.source}`)).toEqual([
      'advisor:builtin',
      'docs:project',
      'explorer:builtin',
      'planner:builtin',
      'reviewer:builtin',
      'worker:project',
    ]);
    // 不带项目时看不到项目的角色。
    expect((await store.get('worker'))?.description).toBe('User worker');
    expect(await store.get('docs')).toBeUndefined();
    expect((await store.get('docs', project))?.instructions).toBe('Body.');
  });
});

describe('引擎自带工具的限制', () => {
  it('类别名与 Claude Code 的工具名换成 engineTools；只写应用级工具时不限引擎', () => {
    expect(roleEngineTools({ tools: ['readonly'] })).toBeUndefined();
    expect(roleEngineTools(undefined)).toBeUndefined();
    expect(roleEngineTools({ disallowedTools: ['Bash', 'mcp__github__*'] })).toEqual({
      denied: ['shell'],
      deniedNames: ['Bash', 'mcp__github__*'],
    });
    expect(roleEngineTools({ disallowedTools: ['edit'] })).toEqual({
      denied: ['edit'],
      deniedNames: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    });
    // 允许列表：一个都没许到的类别算关掉；禁掉某一类里的一个，按类执行的引擎整类关掉，Claude 另按名字精确收窄。
    expect(roleEngineTools({ tools: ['Read', 'Grep', 'readonly'] })).toEqual({
      denied: ['edit', 'shell', 'web'],
      deniedNames: [],
      allowedNames: ['Read', 'Grep'],
    });
    expect(
      roleEngineTools({ tools: ['Read', 'Grep', 'readonly'], disallowedTools: ['Grep'] }),
    ).toEqual({
      denied: ['read', 'edit', 'shell', 'web'],
      deniedNames: ['Grep'],
      allowedNames: ['Read'],
    });
  });

  it('应用级工具的过滤只看应用级的写法；关掉 shell / web 时一并去掉后台进程与联网、浏览器', () => {
    const engineOnly = { tools: ['Read', 'Grep'] };
    expect(roleAllowsTool(engineOnly, tool('wevir_session_create'))).toBe(true);
    expect(roleAllowsTool(engineOnly, tool('wevir_process_start'))).toBe(false);
    expect(roleAllowsTool(engineOnly, tool('wevir_web_search', true))).toBe(false);
    expect(roleAllowsTool(engineOnly, tool('browser_click'))).toBe(false);
    const mixed = { tools: ['Read', 'readonly'] };
    expect(roleAllowsTool(mixed, tool('wevir_session_list', true))).toBe(true);
    expect(roleAllowsTool(mixed, tool('wevir_session_create'))).toBe(false);
    // 空的允许列表照旧是一个都不许。
    expect(roleAllowsTool({ tools: [] }, tool('wevir_session_list', true))).toBe(false);
    expect(roleAllowsTool({ disallowedTools: ['Bash'] }, tool('wevir_process_list', true))).toBe(
      false,
    );
    expect(roleAllowsTool({ disallowedTools: ['Bash'] }, tool('browser_click'))).toBe(true);
  });

  it('effort 是 reasoningEffort 的别名，model: inherit 等于不写', () => {
    const role = parseRole('user', 'x.md', file('description: X\nmodel: inherit\neffort: high'));
    expect(role).toMatchObject({ name: 'x', reasoningEffort: 'high' });
    expect(role).not.toHaveProperty('modelId');
  });
});

describe('Claude Code 与 Codex 的 agent', () => {
  it('Claude Code：frontmatter 换成角色，说明超长时截断，permissionMode 换成上限', () => {
    const role = parseClaudeAgent(
      'project',
      'code_reviewer.md',
      file(
        [
          'name: Code_Reviewer',
          `description: ${'Reviews code. '.repeat(40)}`,
          'tools: Read, Grep, Glob',
          'model: sonnet',
          'permissionMode: plan',
        ].join('\n'),
        'You review code.',
      ),
    );
    expect(role).toMatchObject({
      name: 'code-reviewer',
      source: 'project',
      importedFrom: 'claude',
      tools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['edit'],
      modelId: 'sonnet',
      permissionMode: 'on_request',
      instructions: 'You review code.',
    });
    if ('message' in role) throw new Error(role.message);
    expect(Array.from(role.description)).toHaveLength(ROLE_DESCRIPTION_MAX);
    expect(role.description.endsWith('…')).toBe(true);
    expect(
      parseClaudeAgent('user', 'x.md', file('description: X\npermissionMode: acceptEdits')),
    ).not.toHaveProperty('permissionMode');
  });

  it('Codex：TOML 换成角色，沙箱、shell 与联网的开关换成限制', () => {
    const role = parseCodexAgent(
      'user',
      'explorer.toml',
      [
        'description = "Read-only explorer"',
        'model = "gpt-5.5"',
        'model_reasoning_effort = "low"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        'developer_instructions = """Explore, do not edit."""',
        '[features]',
        'shell_tool = false',
      ].join('\n'),
    );
    expect(role).toEqual({
      name: 'explorer',
      description: 'Read-only explorer',
      source: 'user',
      importedFrom: 'codex',
      instructions: 'Explore, do not edit.',
      modelId: 'gpt-5.5',
      reasoningEffort: 'low',
      permissionMode: 'on_request',
      disallowedTools: ['edit', 'shell', 'web'],
    });
    expect(parseCodexAgent('user', 'bad.toml', 'description = ')).toMatchObject({
      message: expect.stringContaining('invalid TOML'),
    });
  });

  it('RoleStore 读用户级与项目级的 agent：每一级里 Claude < Codex < Wevir，读不进来的另列', async () => {
    const root = tempDir();
    const userHome = join(root, 'home');
    const project = join(root, 'project');
    for (const dir of [
      join(userHome, '.claude', 'agents'),
      join(userHome, 'codex-home', 'agents'),
      join(project, '.claude', 'agents'),
      join(project, '.codex', 'agents'),
      join(project, '.wevir', 'roles'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      join(userHome, '.claude', 'agents', 'helper.md'),
      file('description: Claude helper'),
    );
    writeFileSync(join(userHome, '.claude', 'agents', 'broken.md'), 'no frontmatter');
    writeFileSync(
      join(userHome, 'codex-home', 'agents', 'helper.toml'),
      'description = "Codex helper"\ndeveloper_instructions = "Help."',
    );
    writeFileSync(join(project, '.claude', 'agents', 'docs.md'), file('description: Claude docs'));
    writeFileSync(join(project, '.codex', 'agents', 'docs.toml'), 'description = "Codex docs"');
    writeFileSync(join(project, '.wevir', 'roles', 'docs.md'), file('description: Wevir docs'));
    const store = new RoleStore({
      dir: join(root, 'roles'),
      externalHome: { userHome, env: { CODEX_HOME: join(userHome, 'codex-home') } },
    });
    const { roles, problems } = await store.list(project);
    expect(roles.find((role) => role.name === 'helper')).toMatchObject({
      description: 'Codex helper',
      source: 'user',
      importedFrom: 'codex',
    });
    expect(roles.find((role) => role.name === 'docs')).toMatchObject({
      description: 'Wevir docs',
      source: 'project',
    });
    expect(problems).toEqual([
      { source: 'user', file: '.claude/agents/broken.md', message: expect.any(String) },
    ]);
    // 没给主目录时只读项目里的。
    const projectOnly = await new RoleStore({ dir: join(root, 'roles') }).list(project);
    expect(projectOnly.roles.some((role) => role.name === 'helper')).toBe(false);
  });
});
