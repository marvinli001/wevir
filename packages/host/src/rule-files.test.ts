// 跨引擎的规则文件（0.68.0）：找文件、`@` 引入、Cursor 规则，与按引擎排出补给的计划。

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EngineRuleFiles } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  discoverRuleFiles,
  importPaths,
  planRules,
  RULE_FILES_BUDGET_BYTES,
  sameRules,
} from './rule-files.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();

const CODEX: EngineRuleFiles = {
  user: ['agents'],
  project: ['agents'],
  imports: false,
  instructions: true,
};
const CLAUDE: EngineRuleFiles = {
  user: ['claude'],
  project: ['claude'],
  imports: true,
  instructions: true,
};

function layout(files: Record<string, string>) {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const repo = join(home, 'code', 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return { root, home, repo };
}

describe('discoverRuleFiles', () => {
  it('用户级在前，项目里从仓库根到会话目录，每层按固定先后', async () => {
    const { home, repo } = layout({
      'home/.codex/AGENTS.md': 'user agents',
      'home/.claude/CLAUDE.md': 'user claude',
      'home/.gemini/GEMINI.md': 'user gemini',
      'home/code/AGENTS.md': 'above the repo',
      'home/code/repo/AGENTS.md': 'root agents',
      'home/code/repo/CLAUDE.md': 'root claude',
      'home/code/repo/.claude/CLAUDE.md': 'dot claude',
      'home/code/repo/CLAUDE.local.md': 'local claude',
      'home/code/repo/pkg/GEMINI.md': 'pkg gemini',
      'home/code/repo/pkg/app/AGENTS.md': 'app agents',
    });
    const cwd = join(repo, 'pkg', 'app');
    const found = await discoverRuleFiles({ cwd, home, env: {} });
    expect(found.map((file) => [file.path, file.scope, file.kind])).toEqual([
      [join(home, '.codex', 'AGENTS.md'), 'user', 'agents'],
      [join(home, '.claude', 'CLAUDE.md'), 'user', 'claude'],
      [join(home, '.gemini', 'GEMINI.md'), 'user', 'gemini'],
      [join(repo, 'AGENTS.md'), 'project', 'agents'],
      [join(repo, 'CLAUDE.md'), 'project', 'claude'],
      [join(repo, '.claude', 'CLAUDE.md'), 'project', 'claude'],
      [join(repo, 'CLAUDE.local.md'), 'project', 'claude'],
      [join(repo, 'pkg', 'GEMINI.md'), 'project', 'gemini'],
      [join(cwd, 'AGENTS.md'), 'project', 'agents'],
    ]);
    expect(found[0]).toMatchObject({ text: 'user agents', bytes: 11 });
  });

  it('CODEX_HOME 与 CLAUDE_CONFIG_DIR 换用户级文件的位置；不在仓库里时只看会话目录', async () => {
    const { root, home } = layout({
      'codex-home/AGENTS.md': 'custom codex',
      'claude-home/CLAUDE.md': 'custom claude',
      'home/.codex/AGENTS.md': 'ignored',
      'loose/AGENTS.md': 'loose',
      'AGENTS.md': 'parent of loose',
    });
    const found = await discoverRuleFiles({
      cwd: join(root, 'loose'),
      home,
      env: { CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home') },
    });
    expect(found.map((file) => file.text)).toEqual(['custom codex', 'custom claude', 'loose']);
  });

  it('展开 CLAUDE.md 的 @ 引入（相对、~/、多层），同一个文件只算一次', async () => {
    const { home, repo } = layout({
      'home/code/repo/AGENTS.md': 'agents body',
      'home/code/repo/CLAUDE.md':
        '参见 @AGENTS.md（仓库规则）。\nAlso @docs/style.md and @~/notes/me.md.\n`@ignored.md` and a@b.com\n```\n@fenced.md\n```\n',
      'home/code/repo/docs/style.md': 'style, see @deeper.md',
      'home/code/repo/docs/deeper.md': 'deeper',
      'home/notes/me.md': 'personal',
      'home/code/repo/ignored.md': 'no',
      'home/code/repo/fenced.md': 'no',
    });
    const found = await discoverRuleFiles({ cwd: repo, home, env: {} });
    expect(found.map((file) => [file.path, file.importedFrom])).toEqual([
      [join(repo, 'AGENTS.md'), undefined],
      [join(repo, 'CLAUDE.md'), undefined],
      [join(repo, 'docs', 'style.md'), join(repo, 'CLAUDE.md')],
      [join(repo, 'docs', 'deeper.md'), join(repo, 'docs', 'style.md')],
      [join(home, 'notes', 'me.md'), join(repo, 'CLAUDE.md')],
    ]);
    const claude = found[1];
    expect(claude?.imports).toEqual([
      join(repo, 'AGENTS.md'),
      join(repo, 'docs', 'style.md'),
      join(home, 'notes', 'me.md'),
    ]);
    expect(found[2]).toMatchObject({ kind: 'claude', scope: 'project' });
  });

  it('符号链接到同一个文件的只列第一个', async () => {
    const { home, repo } = layout({ 'home/code/repo/AGENTS.md': 'shared' });
    symlinkSync(join(repo, 'AGENTS.md'), join(repo, 'CLAUDE.md'));
    const found = await discoverRuleFiles({ cwd: repo, home, env: {} });
    expect(found.map((file) => file.path)).toEqual([join(repo, 'AGENTS.md')]);
  });

  it('Cursor 规则只取 alwaysApply 的正文；.cursorrules 整份', async () => {
    const { home, repo } = layout({
      'home/code/repo/.cursorrules': 'legacy rules',
      'home/code/repo/.cursor/rules/always.mdc':
        '---\ndescription: base\nalwaysApply: true\n---\nAlways do this.\n',
      'home/code/repo/.cursor/rules/nested/b.md': '---\nalwaysApply: true\n---\nNested.',
      'home/code/repo/.cursor/rules/glob.mdc': '---\nglobs: "*.ts"\nalwaysApply: false\n---\nTS.',
      'home/code/repo/.cursor/rules/plain.mdc': 'No frontmatter.',
    });
    const found = await discoverRuleFiles({ cwd: repo, home, env: {} });
    expect(found.map((file) => [file.path, file.kind, file.text])).toEqual([
      [join(repo, '.cursorrules'), 'cursor', 'legacy rules'],
      [join(repo, '.cursor', 'rules', 'always.mdc'), 'cursor', 'Always do this.\n'],
      [join(repo, '.cursor', 'rules', 'nested', 'b.md'), 'cursor', 'Nested.'],
    ]);
  });
});

describe('importPaths', () => {
  it('只取 ASCII 文件名字符，去掉句末句点，跳过不像路径的 @', () => {
    expect(importPaths('@AGENTS.md。 @team and @scope/pkg. @./a.md.', '/r', '/h')).toEqual([
      '/r/AGENTS.md',
      '/r/scope/pkg',
      '/r/a.md',
    ]);
  });
});

describe('planRules', () => {
  async function found(files: Record<string, string>) {
    const { home, repo } = layout(files);
    return { files: await discoverRuleFiles({ cwd: repo, home, env: {} }), repo, home };
  }

  it('Codex：自己读 AGENTS.md，补 CLAUDE.md 与它引入的文件；正文带路径', async () => {
    const { files, repo } = await found({
      'home/code/repo/AGENTS.md': 'agents body',
      'home/code/repo/CLAUDE.md': 'Use tabs. See @AGENTS.md and @docs/x.md',
      'home/code/repo/docs/x.md': 'extra rule',
    });
    const plan = planRules(files, { providerId: 'codex', engine: CODEX, enabled: true });
    expect(plan.rules.files.map((file) => [file.path, file.delivery])).toEqual([
      [join(repo, 'AGENTS.md'), 'engine'],
      [join(repo, 'CLAUDE.md'), 'wevir'],
      [join(repo, 'docs', 'x.md'), 'wevir'],
    ]);
    expect(plan.rules).toMatchObject({
      providerId: 'codex',
      channel: 'instructions',
      budgetBytes: RULE_FILES_BUDGET_BYTES,
    });
    expect(plan.rules.bytes).toBe(Buffer.byteLength(plan.text ?? ''));
    expect(plan.text).toContain(`<rule_file path="${join(repo, 'CLAUDE.md')}" scope="project">`);
    expect(plan.text).toContain('Use tabs.');
    expect(plan.text).toContain(`imported_from="${join(repo, 'CLAUDE.md')}"`);
    expect(plan.text).not.toContain('agents body');
  });

  it('Claude 展开 @：CLAUDE.md 引入的 AGENTS.md 已经读了，不补', async () => {
    const { files } = await found({
      'home/code/repo/AGENTS.md': 'agents body',
      'home/code/repo/CLAUDE.md': '参见 @AGENTS.md（仓库规则）。',
    });
    const plan = planRules(files, { providerId: 'claude', engine: CLAUDE, enabled: true });
    expect(plan.rules.files.map((file) => file.delivery)).toEqual(['engine', 'engine']);
    expect(plan.text).toBeUndefined();
    expect(plan.rules.channel).toBeUndefined();
  });

  it('引擎不展开 @ 时，它读的文件引入的照样补', async () => {
    const { files, repo } = await found({
      'home/code/repo/CLAUDE.md': 'See @docs/x.md',
      'home/code/repo/docs/x.md': 'extra rule',
    });
    const plan = planRules(files, {
      providerId: 'opencode',
      engine: { ...CLAUDE, imports: false },
      enabled: true,
    });
    expect(plan.rules.files.map((file) => [file.path, file.delivery])).toEqual([
      [join(repo, 'CLAUDE.md'), 'engine'],
      [join(repo, 'docs', 'x.md'), 'wevir'],
    ]);
  });

  it('后备的种类：项目里没有首选的才算引擎读的', async () => {
    const opencode: EngineRuleFiles = { ...CODEX, projectFallback: ['claude'] };
    const only = await found({ 'home/code/repo/CLAUDE.md': 'claude only' });
    expect(
      planRules(only.files, { providerId: 'o', engine: opencode, enabled: true }).rules.files.map(
        (file) => file.delivery,
      ),
    ).toEqual(['engine']);
    const both = await found({
      'home/code/repo/AGENTS.md': 'agents',
      'home/code/repo/CLAUDE.md': 'claude',
    });
    expect(
      planRules(both.files, { providerId: 'o', engine: opencode, enabled: true }).rules.files.map(
        (file) => file.delivery,
      ),
    ).toEqual(['engine', 'wevir']);
  });

  it('内容相同的跳过；空文件、关着的设置各有原因；没声明的引擎随消息补', async () => {
    const { files } = await found({
      'home/code/repo/AGENTS.md': 'same rules\n',
      'home/code/repo/CLAUDE.md': 'same rules',
      'home/code/repo/GEMINI.md': '  \n',
      'home/code/repo/.cursorrules': 'cursor only',
    });
    const codex = planRules(files, { providerId: 'codex', engine: CODEX, enabled: true });
    expect(codex.rules.files.map((file) => [file.delivery, file.skipReason])).toEqual([
      ['engine', undefined],
      ['skipped', 'duplicate'],
      ['skipped', 'empty'],
      ['wevir', undefined],
    ]);
    const off = planRules(files, { providerId: 'codex', engine: CODEX, enabled: false });
    expect(off.rules.files.map((file) => file.skipReason)).toEqual([
      undefined,
      'disabled',
      'empty',
      'disabled',
    ]);
    expect(off.text).toBeUndefined();
    const unknown = planRules(files, { providerId: 'x', engine: undefined, enabled: true });
    expect(unknown.rules.channel).toBe('message');
    expect(unknown.rules.files.map((file) => file.delivery)).toEqual([
      'wevir',
      'skipped',
      'skipped',
      'wevir',
    ]);
  });

  it('超出预算：放不下整份的截一段，再放不下的不补', async () => {
    const { files } = await found({
      'home/code/repo/CLAUDE.md': `first ${'a'.repeat(3000)}`,
      'home/code/repo/GEMINI.md': `中文${'字'.repeat(2000)}`,
      'home/code/repo/.cursorrules': 'last',
    });
    const plan = planRules(files, {
      providerId: 'codex',
      engine: CODEX,
      enabled: true,
      budgetBytes: 4000,
    });
    expect(
      plan.rules.files.map((file) => [file.delivery, file.truncated, file.skipReason]),
    ).toEqual([
      ['wevir', undefined, undefined],
      ['wevir', true, undefined],
      ['skipped', undefined, 'over_budget'],
    ]);
    expect(Buffer.byteLength(plan.text ?? '')).toBeLessThanOrEqual(4000 + 1000);
    expect(plan.text).toContain('[Truncated: the rest of this file');
    expect(plan.text).not.toContain('�');
  });

  it('同样的输入给同样的结果；sameRules 只看列表', async () => {
    const { files } = await found({ 'home/code/repo/CLAUDE.md': 'x' });
    const a = planRules(files, { providerId: 'codex', engine: CODEX, enabled: true });
    const b = planRules(files, { providerId: 'codex', engine: CODEX, enabled: true });
    expect(b).toEqual(a);
    expect(sameRules(a.rules, b.rules)).toBe(true);
    expect(sameRules(undefined, b.rules)).toBe(false);
    expect(sameRules(a.rules, { ...b.rules, providerId: 'claude' })).toBe(false);
  });
});
