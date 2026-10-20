import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { scanAntigravity } from './antigravity.js';
import { claudeProjectDir, scanClaude } from './claude.js';
import { appliesToCwd, scanCodex, taskGroups } from './codex.js';
import {
  argsLookSecret,
  convertMcp,
  type ImportProject,
  matchProject,
  type ScanContext,
  samePath,
  urlLooksSecret,
  within,
} from './common.js';
import { scanGrok } from './grok.js';

const temp = useTempDir();

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const skill = (root: string, name: string, extra = '') =>
  put(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody${extra}\n`,
  );
const WS_A = 'ws_a' as WorkspaceId;
const WS_B = 'ws_b' as WorkspaceId;

function context(projects: ImportProject[], env: ScanContext['env'] = {}): ScanContext {
  return { userHome: join(temp(), 'home'), env, projects };
}

describe('路径比较', () => {
  it('Windows 路径不分大小写与斜杠方向，posix 路径分大小写', () => {
    expect(samePath('C:\\Users\\Me\\Proj', 'c:/users/me/proj/')).toBe(true);
    expect(samePath('/Users/me/Proj', '/Users/me/proj')).toBe(false);
    expect(within('C:\\Users\\me\\proj\\sub', 'c:/Users/me/proj')).toBe(true);
    expect(within('C:\\Users\\me\\project', 'C:\\Users\\me\\proj')).toBe(false);
    expect(within('/a/b/c', '/a/b')).toBe(true);
    const projects = [{ id: WS_A, folders: ['/x/main', 'D:\\work\\extra'] }];
    expect(matchProject(projects, 'd:/WORK/extra')).toEqual({
      workspaceId: WS_A,
      folder: 'D:\\work\\extra',
    });
    expect(matchProject(projects, '/x/main/sub')).toBeUndefined();
    expect(matchProject(projects, '/x/main/sub', true)?.workspaceId).toBe(WS_A);
  });

  it('Claude 的项目目录名：非字母数字都换成 -', () => {
    expect(claudeProjectDir('/Users/me/my.proj')).toBe('-Users-me-my-proj');
    expect(claudeProjectDir('C:\\Users\\me\\proj')).toBe('C--Users-me-proj');
  });
});

describe('MCP 配置转换', () => {
  it('stdio：env 只留键名；http：headers 只留键名；SSE 不支持', () => {
    expect(
      convertMcp(
        { command: 'npx', args: ['-y', 'pkg', 3], env: { TOKEN: 'real-value', MODE: 'x' } },
        'json',
      ),
    ).toEqual({
      config: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg', '3'],
        env: { TOKEN: '', MODE: '' },
      },
      pending: ['TOKEN', 'MODE'],
    });
    expect(
      convertMcp(
        { type: 'http', url: 'https://mcp.example.com/', headers: { Authorization: 'Bearer x' } },
        'json',
      ),
    ).toEqual({
      config: {
        transport: 'http',
        url: 'https://mcp.example.com/',
        headers: { Authorization: '' },
      },
      pending: ['Authorization'],
    });
    expect(convertMcp({ type: 'sse', url: 'https://x.example/sse' }, 'json').problem).toBe(
      'unsupported_transport',
    );
    expect(convertMcp({ args: [] }, 'json').problem).toBe('invalid');
    expect(convertMcp({ command: 'x', disabled: true }, 'json').config?.enabled).toBe(false);
  });

  it('参数或地址像密钥的报 looks_secret', () => {
    expect(argsLookSecret(['--api-key', 'abcdef123456'])).toBe(true);
    expect(argsLookSecret(['--token=abcdefgh'])).toBe(true);
    expect(argsLookSecret(['sk-abcdefghijklmnopqrstuvwxyz'])).toBe(true);
    expect(argsLookSecret(['--port', '8080', '-y', 'pkg'])).toBe(false);
    expect(urlLooksSecret('https://x.example/mcp?api_key=abcdef1234')).toBe(true);
    expect(urlLooksSecret('https://user:pass@x.example/mcp')).toBe(true);
    expect(urlLooksSecret('https://x.example/mcp?version=2')).toBe(false);
    expect(convertMcp({ command: 'srv', args: ['--token', 'abcdef123456'] }, 'json').problem).toBe(
      'looks_secret',
    );
    expect(convertMcp({ url: 'https://x.example/?token=abcdef12345' }, 'json').problem).toBe(
      'looks_secret',
    );
  });

  it('Codex 的字段：env_vars、http_headers、env_http_headers、bearer_token_env_var', () => {
    expect(
      convertMcp(
        { command: 'srv', env: { A: '1' }, env_vars: ['B', { name: 'C', source: 'local' }] },
        'codex',
      ),
    ).toMatchObject({ config: { env: { A: '', B: '', C: '' } }, pending: ['A', 'B', 'C'] });
    expect(
      convertMcp(
        {
          url: 'https://mcp.example.com/mcp',
          http_headers: { 'X-Team': 'abc' },
          env_http_headers: { 'X-Key': 'KEY_VAR' },
          bearer_token_env_var: 'TOKEN_VAR',
          tool_timeout_sec: 30,
          enabled: false,
        },
        'codex',
      ),
    ).toEqual({
      config: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Team': '', 'X-Key': '', Authorization: '' },
        enabled: false,
        toolTimeoutSec: 30,
      },
      pending: ['X-Team', 'X-Key', 'Authorization'],
    });
  });
});

describe('Claude Code', () => {
  it('记忆按项目目录对上 Wevir 项目（含 Windows 路径），跳过 MEMORY.md，名字规范化', async () => {
    const ctx = context([
      { id: WS_A, folders: ['/work/app'] },
      { id: WS_B, folders: ['C:\\Users\\Me\\Proj'] },
    ]);
    const projects = join(ctx.userHome, '.claude', 'projects');
    put(join(projects, '-work-app', 'memory', 'MEMORY.md'), '- [x](x.md)\n');
    put(
      join(projects, '-work-app', 'memory', 'style.md'),
      '---\nname: Code Style_Rules\ndescription: Use tabs\nmetadata:\n  type: feedback\n---\n\nAlways tabs.\n',
    );
    put(
      join(projects, 'c--users-me-proj', 'memory', 'win.md'),
      '---\nname: win\ndescription: Windows note\ntype: user\n---\nBody\n',
    );
    put(
      join(projects, '-elsewhere', 'memory', 'other.md'),
      '---\nname: other\ndescription: Other\ntype: reference\n---\nBody\n',
    );
    put(
      join(projects, '-elsewhere', 'memory', 'secret.md'),
      '---\nname: secret\ndescription: Key\ntype: reference\n---\nsk-abcdefghijklmnopqrstuvwxyz0123\n',
    );
    put(
      join(projects, '-elsewhere', 'memory', 'big.md'),
      `---\nname: big\ndescription: Big\ntype: project\n---\n${'x'.repeat(5000)}\n`,
    );
    const scan = await scanClaude(ctx);
    expect(scan.found).toBe(true);
    expect(scan.home).toBe(join(ctx.userHome, '.claude'));
    const byName = new Map(scan.memories.map((item) => [item.name, item]));
    expect([...byName.keys()].sort()).toEqual([
      'big',
      'code-style-rules',
      'other',
      'secret',
      'win',
    ]);
    expect(byName.get('code-style-rules')).toMatchObject({
      type: 'feedback',
      description: 'Use tabs',
      content: 'Always tabs.',
      scope: 'project',
      workspaceId: WS_A,
      project: '/work/app',
    });
    expect(byName.get('win')).toMatchObject({
      scope: 'project',
      workspaceId: WS_B,
      project: 'C:\\Users\\Me\\Proj',
    });
    expect(byName.get('other')).toMatchObject({ scope: 'global', project: '-elsewhere' });
    expect(byName.get('other')?.workspaceId).toBeUndefined();
    expect(byName.get('secret')).toMatchObject({ problem: 'looks_secret', content: '' });
    expect(byName.get('big')?.problem).toBe('too_large');
    // 同一份文件每次扫描的 key 一样。
    const again = await scanClaude(ctx);
    expect(again.memories.map((item) => item.key)).toEqual(scan.memories.map((item) => item.key));
  });

  it('MCP：.claude.json 的全局与项目表、项目文件夹的 .mcp.json；值不带出来', async () => {
    const folder = join(temp(), 'project');
    const ctx = context([
      { id: WS_A, folders: [folder] },
      { id: WS_B, folders: ['D:\\code\\win'] },
    ]);
    put(
      join(ctx.userHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          GitHub: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'ghp_secretvalue' } },
          stream: { type: 'sse', url: 'https://x.example/sse' },
        },
        projects: {
          'd:/Code/Win': {
            mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } },
          },
          '/not/in/wevir': { mcpServers: { docs: { command: 'docs' } } },
        },
      }),
    );
    put(join(ctx.userHome, '.claude', 'settings.json'), '{}');
    put(
      join(folder, '.mcp.json'),
      JSON.stringify({ mcpServers: { local: { command: 'node', args: ['srv.js'] } } }),
    );
    const scan = await scanClaude(ctx);
    expect(JSON.stringify(scan)).not.toContain('ghp_secretvalue');
    const rows = scan.connectors.map((item) => ({
      name: item.name,
      workspaceId: item.workspaceId,
      project: item.project,
      problem: item.problem,
      recommended: item.recommended,
    }));
    expect(rows).toEqual([
      {
        name: 'github',
        workspaceId: undefined,
        project: undefined,
        problem: undefined,
        recommended: undefined,
      },
      {
        name: 'stream',
        workspaceId: undefined,
        project: undefined,
        problem: 'unsupported_transport',
        recommended: undefined,
      },
      {
        name: 'docs',
        workspaceId: WS_B,
        project: 'd:/Code/Win',
        problem: undefined,
        recommended: undefined,
      },
      {
        name: 'docs',
        workspaceId: undefined,
        project: '/not/in/wevir',
        problem: undefined,
        recommended: false,
      },
      {
        name: 'local',
        workspaceId: WS_A,
        project: folder,
        problem: undefined,
        recommended: undefined,
      },
    ]);
    expect(scan.connectors[0]?.pending).toEqual(['GITHUB_TOKEN']);
    expect(new Set(scan.connectors.map((item) => item.key)).size).toBe(5);
  });

  it('CLAUDE_CONFIG_DIR：配置目录与 .claude.json 都在那里', async () => {
    const dir = join(temp(), 'claude-config');
    const ctx = context([], { CLAUDE_CONFIG_DIR: dir });
    put(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { one: { command: 'one' } } }));
    put(
      join(ctx.userHome, '.claude.json'),
      JSON.stringify({ mcpServers: { two: { command: 'two' } } }),
    );
    skill(join(dir, 'skills'), 'alpha');
    const scan = await scanClaude(ctx);
    expect(scan.home).toBe(dir);
    expect(scan.connectors.map((item) => item.name)).toEqual(['one']);
    expect(scan.skills.map((item) => item.name)).toEqual(['alpha']);
  });

  it('没有用户目录时 found 为 false', async () => {
    const scan = await scanClaude(context([]));
    expect(scan).toMatchObject({ found: false, memories: [], connectors: [], skills: [] });
  });
});

describe('Codex', () => {
  const memory = [
    'intro line',
    '# Task Group: Wevir host work',
    '',
    'scope: host package',
    'applies_to: cwd=C:\\Users\\Me\\wevir\\packages; reuse_rule=safe',
    '',
    '## Task 1: thing',
    '- detail',
    '# Task Group: Wevir host work',
    'applies_to: cwd=/nowhere; reuse_rule=x',
    'second',
    '# Task Group: Huge',
    'applies_to: cwd=/work/app',
    'y'.repeat(5000),
  ].join('\n');

  it('MEMORY.md 按 Task Group 拆开，applies_to 的 cwd 对上项目（含 Windows 路径），一律不默认勾选', async () => {
    expect(taskGroups(memory).map((group) => group.title)).toEqual([
      'Wevir host work',
      'Wevir host work',
      'Huge',
    ]);
    expect(appliesToCwd('applies_to: cwd=/a/b; reuse_rule=x')).toBe('/a/b');
    const ctx = context([
      { id: WS_A, folders: ['/work/app'] },
      { id: WS_B, folders: ['c:/users/me/wevir'] },
    ]);
    put(join(ctx.userHome, '.codex', 'memories', 'MEMORY.md'), memory);
    const scan = await scanCodex(ctx);
    expect(
      scan.memories.map(
        ({ name, type, description, scope, workspaceId, problem, recommended }) => ({
          name,
          type,
          description,
          scope,
          workspaceId,
          problem,
          recommended,
        }),
      ),
    ).toEqual([
      {
        name: 'wevir-host-work',
        type: 'project',
        description: 'Wevir host work',
        scope: 'project',
        workspaceId: WS_B,
        problem: undefined,
        recommended: false,
      },
      {
        name: 'wevir-host-work-2',
        type: 'project',
        description: 'Wevir host work',
        scope: 'global',
        workspaceId: undefined,
        problem: undefined,
        recommended: false,
      },
      {
        name: 'huge',
        type: 'project',
        description: 'Huge',
        scope: 'project',
        workspaceId: WS_A,
        problem: 'too_large',
        recommended: false,
      },
    ]);
    expect(scan.memories[0]?.content).toContain('## Task 1: thing');
    expect(scan.memories[0]?.content).not.toContain('# Task Group');
    expect(new Set(scan.memories.map((item) => item.key)).size).toBe(3);
  });

  it('config.toml 与项目的 .codex/config.toml、CODEX_HOME，skills 跳过 .system', async () => {
    const home = join(temp(), 'codex-home');
    const folder = join(temp(), 'project');
    const ctx = context([{ id: WS_A, folders: [folder] }], { CODEX_HOME: home });
    put(
      join(home, 'config.toml'),
      [
        'model = "x"',
        '[mcp_servers.docs]',
        'url = "https://docs.example/mcp"',
        'bearer_token_env_var = "DOCS_TOKEN"',
        '[mcp_servers.local]',
        'command = "node"',
        'args = ["srv.js"]',
        'env = { API_KEY = "real-secret-value" }',
      ].join('\n'),
    );
    put(join(folder, '.codex', 'config.toml'), '[mcp_servers.proj]\ncommand = "proj-mcp"\n');
    skill(join(home, 'skills'), 'mine');
    skill(join(home, 'skills', '.system'), 'builtin');
    const scan = await scanCodex(ctx);
    expect(scan.home).toBe(home);
    expect(JSON.stringify(scan)).not.toContain('real-secret-value');
    expect(scan.connectors.map((item) => [item.name, item.workspaceId, item.pending])).toEqual([
      ['docs', undefined, ['Authorization']],
      ['local', undefined, ['API_KEY']],
      ['proj', WS_A, []],
    ]);
    expect(scan.skills.map((item) => item.name)).toEqual(['mine']);
  });

  it('config.toml 坏了不影响别的', async () => {
    const ctx = context([]);
    put(join(ctx.userHome, '.codex', 'config.toml'), '[mcp_servers.x\n');
    skill(join(ctx.userHome, '.codex', 'skills'), 'ok');
    const scan = await scanCodex(ctx);
    expect(scan.connectors).toEqual([]);
    expect(scan.skills.map((item) => item.name)).toEqual(['ok']);
  });
});

describe('Grok Build', () => {
  it('只有 skills，GROK_HOME 优先；记忆与 MCP 报 unsupported', async () => {
    const home = join(temp(), 'grok-home');
    skill(join(home, 'skills'), 'g1');
    const scan = await scanGrok(context([], { GROK_HOME: home }));
    expect(scan).toMatchObject({ home, found: true, unsupported: ['memory', 'connector'] });
    expect(scan.skills.map((item) => item.name)).toEqual(['g1']);
    const plain = await scanGrok(context([]));
    expect(plain.found).toBe(false);
  });
});

describe('Antigravity', () => {
  it('两个用户 skills 目录加 skills.json 的目录，serverUrl 当 http，不读 OAuth 令牌文件', async () => {
    const ctx = context([]);
    const gemini = join(ctx.userHome, '.gemini');
    skill(join(gemini, 'config', 'skills'), 'a1');
    skill(join(gemini, 'antigravity-cli', 'skills'), 'a2');
    skill(join(ctx.userHome, 'extra-skills'), 'a3');
    put(
      join(gemini, 'config', 'skills.json'),
      JSON.stringify({ entries: [{ path: '~/extra-skills' }, { path: 42 }] }),
    );
    put(
      join(gemini, 'config', 'mcp_config.json'),
      JSON.stringify({
        mcpServers: {
          supabase: { serverUrl: 'https://mcp.supabase.example/mcp', headers: { Auth: 'x' } },
        },
      }),
    );
    put(join(gemini, 'antigravity', 'mcp_oauth_tokens.json'), '{"token":"oauth-token-value"}');
    const scan = await scanAntigravity(ctx);
    expect(scan).toMatchObject({ found: true, unsupported: ['memory'] });
    expect(scan.skills.map((item) => item.name).sort()).toEqual(['a1', 'a2', 'a3']);
    expect(scan.connectors).toMatchObject([
      {
        name: 'supabase',
        config: {
          transport: 'http',
          url: 'https://mcp.supabase.example/mcp',
          headers: { Auth: '' },
        },
        pending: ['Auth'],
      },
    ]);
    expect(JSON.stringify(scan)).not.toContain('oauth-token-value');
  });
});
