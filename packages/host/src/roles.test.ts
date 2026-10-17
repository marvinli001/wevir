import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  parseRole,
  ROLE_DESCRIPTION_MAX,
  ROLE_INSTRUCTIONS_MAX_BYTES,
  RoleStore,
  roleAllowsTool,
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
    for (const name of ['explorer', 'reviewer']) {
      expect(byName[name]?.tools).toEqual(['readonly']);
      expect(byName[name]?.permissionMode).toBe('on_request');
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
      'explorer',
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
      'docs:project',
      'explorer:builtin',
      'reviewer:builtin',
      'worker:project',
    ]);
    // 不带项目时看不到项目的角色。
    expect((await store.get('worker'))?.description).toBe('User worker');
    expect(await store.get('docs')).toBeUndefined();
    expect((await store.get('docs', project))?.instructions).toBe('Body.');
  });
});
