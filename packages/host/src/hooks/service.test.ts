import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookService } from './service.js';
import type { InstalledPluginHooks } from './sources.js';

const WS = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;

let root: string;
let repo: string;
let plugins: InstalledPluginHooks[];

const table = (event: string, command: string, matcher?: string) => ({
  hooks: {
    [event]: [{ ...(matcher !== undefined && { matcher }), hooks: [{ type: 'command', command }] }],
  },
});

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function service(): HookService {
  return new HookService({
    dir: join(root, 'data'),
    workspaceRoot: (workspaceId) => (workspaceId === WS ? repo : undefined),
    plugins: () => plugins,
    claudeUserSettings: () => ({ path: join(root, 'claude', 'settings.json'), label: '~/.claude' }),
    scanTtlMs: 0,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wevir-hooks-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  plugins = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('HookService', () => {
  it('Wevir 自己的：增删改启停，重启后还在，matcher 写错拒绝', async () => {
    const hooks = service();
    const added = await hooks.add({
      workspaceId: WS,
      event: 'PreToolUse',
      matcher: 'Bash',
      handler: { type: 'command', command: 'echo hi', timeout: 5 },
    });
    expect(added).toMatchObject({
      source: 'wevir',
      workspaceId: WS,
      status: 'enabled',
      engines: ['*'],
    });
    await expect(
      hooks.add({ event: 'Stop', matcher: '(', handler: { type: 'command', command: 'x' } }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await hooks.update({ hookId: added.id, matcher: null, name: '提示' });
    await hooks.setEnabled({ hookId: added.id, enabled: false });
    const reloaded = service()
      .list(WS)
      .hooks.find((hook) => hook.id === added.id);
    expect(reloaded).toMatchObject({ name: '提示', status: 'disabled' });
    expect(reloaded?.matcher).toBeUndefined();
    expect(
      service()
        .list()
        .hooks.some((hook) => hook.id === added.id),
    ).toBe(false);
    await hooks.delete(added.id);
    expect(hooks.list(WS).hooks).toEqual([]);
  });

  it('仓库来源默认不执行；启用记散列，条目或引用的脚本改了变 changed', async () => {
    write(join(repo, 'scripts', 'check.sh'), 'exit 0\n');
    write(join(repo, '.wevir', 'hooks.json'), table('PreToolUse', './scripts/check.sh', 'Bash'));
    write(join(repo, '.claude', 'settings.json'), table('Stop', 'pnpm test'));
    const hooks = service();
    const listed = hooks.list(WS).hooks;
    expect(listed.map((hook) => [hook.source, hook.status, hook.engines])).toEqual([
      ['project', 'disabled', ['*']],
      ['claude_project', 'disabled', ['claude']],
    ]);
    const scope = { workspaceId: WS, cwd: repo, engine: 'codex' };
    const input = { tool_name: 'Bash' };
    expect(hooks.handlers(scope, 'PreToolUse', input)).toEqual([]);

    const project = listed[0];
    if (project === undefined) throw new Error('no project hook');
    const enabled = await hooks.setEnabled({ workspaceId: WS, hookId: project.id, enabled: true });
    expect(enabled.status).toBe('enabled');
    expect(enabled.enabledAt).toBeDefined();
    expect(hooks.handlers(scope, 'PreToolUse', input).map((hook) => hook.command)).toEqual([
      './scripts/check.sh',
    ]);
    // `.claude/` 的只在 Claude 上跑。
    const claude = listed[1];
    if (claude === undefined) throw new Error('no claude hook');
    await hooks.setEnabled({ workspaceId: WS, hookId: claude.id, enabled: true });
    expect(hooks.handlers(scope, 'Stop', {})).toEqual([]);
    expect(hooks.handlers({ ...scope, engine: 'claude' }, 'Stop', {})).toHaveLength(1);

    write(join(repo, 'scripts', 'check.sh'), 'rm -rf ~\n');
    expect(hooks.list(WS).hooks[0]?.status).toBe('changed');
    expect(hooks.handlers(scope, 'PreToolUse', input)).toEqual([]);
  });

  it('插件与 Claude 用户层默认执行，可停用；Claude / Codex 包只在来源引擎上跑', async () => {
    const wevirPlugin = join(root, 'plugins', 'fmt');
    write(join(wevirPlugin, 'wevir-plugin.json'), { hooks: './hooks.json' });
    write(
      join(wevirPlugin, 'hooks.json'),
      table('PostToolUse', '$CLAUDE_PLUGIN_ROOT/fmt.sh', 'Edit'),
    );
    const claudePlugin = join(root, 'plugins', 'cc');
    write(join(claudePlugin, '.claude-plugin', 'plugin.json'), { name: 'cc' });
    write(join(claudePlugin, 'hooks', 'hooks.json'), table('Stop', 'echo done'));
    plugins = [
      { id: 'fmt', path: wevirPlugin, source: 'wevir', enabled: true },
      { id: 'cc', path: claudePlugin, source: 'claude', enabled: true },
    ];
    write(join(root, 'claude', 'settings.json'), table('PreToolUse', 'echo user'));
    const hooks = service();
    expect(
      hooks.list().hooks.map((hook) => [hook.source, hook.pluginId, hook.status, hook.engines]),
    ).toEqual([
      ['claude_user', undefined, 'enabled', ['claude']],
      ['plugin', 'fmt', 'enabled', ['*']],
      ['plugin', 'cc', 'enabled', ['claude']],
    ]);
    const codex = { cwd: repo, engine: 'codex' };
    const [fmt] = hooks.handlers(codex, 'PostToolUse', { tool_name: 'apply_patch' });
    expect(fmt?.env).toEqual({ CLAUDE_PLUGIN_ROOT: wevirPlugin, PLUGIN_ROOT: wevirPlugin });
    expect(hooks.handlers(codex, 'Stop', {})).toEqual([]);
    expect(hooks.handlers({ ...codex, engine: 'claude' }, 'Stop', {})).toHaveLength(1);
    const user = hooks.list().hooks[0];
    if (user === undefined) throw new Error('no user hook');
    await hooks.setEnabled({ hookId: user.id, enabled: false });
    expect(service().list().hooks[0]?.status).toBe('disabled');
    expect(hooks.handlers({ ...codex, engine: 'claude' }, 'PreToolUse', {})).toEqual([]);
  });

  it('不支持的处理器种类照样列出，不能启用；读坏的文件进 warnings', async () => {
    write(join(repo, '.wevir', 'hooks.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'http', url: 'https://example.com' }] }] },
    });
    write(join(repo, '.claude', 'settings.local.json'), '{oops');
    const hooks = service();
    const { hooks: listed, warnings } = hooks.list(WS);
    expect(listed[0]).toMatchObject({ handler: 'http', status: 'unsupported' });
    expect(warnings[0]).toContain('.claude/settings.local.json');
    await expect(
      hooks.setEnabled({ workspaceId: WS, hookId: listed[0]?.id ?? '', enabled: true }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
