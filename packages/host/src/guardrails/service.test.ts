import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { GuardrailId, WorkspaceId } from '@wevir/protocol';
import { guardrailChecker } from '@wevir/runtime-adapter/guardrail';
import { describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { useTempDir } from '../test-utils.js';
import { GuardrailService } from './service.js';

const tempDir = useTempDir();
const WS = 'ws_1' as WorkspaceId;

function setup() {
  const root = realpathSync(tempDir());
  const dir = join(root, 'guardrails');
  const workspace = join(root, 'repo');
  mkdirSync(join(workspace, '.git'), { recursive: true });
  const warnings: string[] = [];
  const make = () =>
    new GuardrailService({
      checker: guardrailChecker(dir, '/usr/bin/node'),
      workspaceRoot: (id) => (id === WS ? workspace : undefined),
      onWarning: (message) => warnings.push(message),
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      platform: 'linux',
    });
  return { root, dir, workspace, warnings, make, service: make() };
}

function repoHooksFile(workspace: string, hooks: unknown) {
  mkdirSync(join(workspace, '.codex'), { recursive: true });
  writeFileSync(join(workspace, '.codex', 'hooks.json'), JSON.stringify({ hooks }));
}

describe('GuardrailService', () => {
  it('增删改与开关：版本加一，按范围存成 0600 文件，重启后还在', async () => {
    const { dir, service, make } = setup();
    const changes: unknown[] = [];
    service.watch((change) => changes.push(change));
    const global = await service.add({
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
    });
    const project = await service.add({
      workspaceId: WS,
      name: ' tests ',
      rule: { kind: 'stop_check', command: 'pnpm test' },
      enabled: false,
    });
    expect(global).toMatchObject({ enabled: true, revision: 1, hits: 0 });
    expect(global.workspaceId).toBeUndefined();
    expect(project).toMatchObject({ workspaceId: WS, name: 'tests', enabled: false });
    expect(service.list().map((g) => g.id)).toEqual([global.id]);
    expect(service.list(WS).map((g) => g.id)).toEqual([global.id, project.id]);

    const renamed = await service.update({ guardrailId: project.id, name: null });
    expect(renamed.name).toBeUndefined();
    expect(renamed.revision).toBe(2);
    const enabled = await service.setEnabled(project.id, true);
    expect(enabled).toMatchObject({ enabled: true, revision: 3 });
    await service.delete(global.id);
    expect(service.list(WS).map((g) => g.id)).toEqual([project.id]);
    expect(changes).toEqual([
      {},
      { workspaceId: WS },
      { workspaceId: WS },
      { workspaceId: WS },
      {},
    ]);

    const file = join(dir, `${WS}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, revision: 3 });
    expect(make().list(WS)).toEqual([enabled]);
    // 检查程序写在 bin/ 下。
    expect(existsSync(join(dir, 'bin', 'wevir-guardrail.mjs'))).toBe(true);
  });

  it('找不到规则回 GUARDRAIL_NOT_FOUND；正则写错与超出上限回 INVALID_PARAMS', async () => {
    const { service } = setup();
    const missing = 'grd_01JAAAAAAAAAAAAAAAAAAAAAAA' as GuardrailId;
    await expect(service.delete(missing)).rejects.toSatisfy((e) =>
      isHostError(e, 'GUARDRAIL_NOT_FOUND'),
    );
    await expect(service.setEnabled(missing, true)).rejects.toSatisfy((e) =>
      isHostError(e, 'GUARDRAIL_NOT_FOUND'),
    );
    await expect(
      service.add({ rule: { kind: 'forbidden_command', match: 'regex', pattern: '(' } }),
    ).rejects.toSatisfy((e) => isHostError(e, 'INVALID_PARAMS'));
    for (let i = 0; i < 50; i += 1) {
      await service.add({ rule: { kind: 'protected_path', glob: `f${i}` } });
    }
    await expect(service.add({ rule: { kind: 'protected_path', glob: 'x' } })).rejects.toSatisfy(
      (e) => isHostError(e, 'INVALID_PARAMS'),
    );
  });

  it('命中计数不改版本；规则已删时不记', async () => {
    const { service } = setup();
    const g = await service.add({ rule: { kind: 'protected_path', glob: '.env' } });
    await service.recordHit(g.id);
    await service.recordHit(g.id);
    expect(service.list()[0]).toMatchObject({
      hits: 2,
      revision: 1,
      lastHitAt: '2026-10-21T00:00:00.000Z',
    });
    await service.delete(g.id);
    await service.recordHit(g.id);
    expect(service.list()).toEqual([]);
  });

  it('坏了的文件按空的处理并告警', () => {
    const { dir, make, warnings } = setup();
    writeFileSync(join(dir, 'global.json'), '{');
    expect(make().list()).toEqual([]);
    expect(warnings).toContain('guardrails file is unreadable, treating it as empty');
  });

  it('仓库 hooks：列出、逐个启用、内容变了要重新启用，非命令的不能启用', async () => {
    const { workspace, service } = setup();
    repoHooksFile(workspace, {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh', timeout: 5 }] },
      ],
      Stop: [{ hooks: [{ type: 'prompt' }] }],
    });
    writeFileSync(
      join(workspace, '.codex', 'config.toml'),
      '[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "echo hi"\n',
    );
    const listed = service.repoHooks(WS);
    expect(listed.warnings).toEqual([]);
    expect(listed.hooks.map((h) => [h.id, h.status])).toEqual([
      ['.codex/hooks.json:PreToolUse:0:0', 'disabled'],
      ['.codex/hooks.json:Stop:0:0', 'unsupported'],
      ['.codex/config.toml:SessionStart:0:0', 'disabled'],
    ]);
    expect(listed.hooks[0]).toMatchObject({
      file: '.codex/hooks.json',
      matcher: 'Bash',
      command: './x.sh',
      timeoutSec: 5,
    });

    const on = await service.setRepoHookEnabled(WS, '.codex/hooks.json:PreToolUse:0:0', true);
    expect(on).toMatchObject({ status: 'enabled', enabledAt: '2026-10-21T00:00:00.000Z' });
    await expect(
      service.setRepoHookEnabled(WS, '.codex/hooks.json:Stop:0:0', true),
    ).rejects.toSatisfy((e) => isHostError(e, 'INVALID_PARAMS'));
    await expect(service.setRepoHookEnabled(WS, 'nope', true)).rejects.toSatisfy((e) =>
      isHostError(e, 'INVALID_PARAMS'),
    );
    expect(() => service.repoHooks('ws_2' as WorkspaceId)).toThrow(/not found/);

    repoHooksFile(workspace, {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: './y.sh', timeout: 5 }] },
      ],
    });
    expect(service.repoHooks(WS).hooks[0]?.status).toBe('changed');
    const off = await service.setRepoHookEnabled(WS, '.codex/hooks.json:PreToolUse:0:0', false);
    expect(off.status).toBe('disabled');

    writeFileSync(join(workspace, '.codex', 'hooks.json'), '{');
    expect(service.repoHooks(WS).warnings).toEqual([
      expect.stringMatching(/^\.codex\/hooks\.json: /),
    ]);
  });

  it('会话的 hooks：按有效规则的种类挂检查程序，仓库 hooks 全部停用，启用且没变的经检查程序转一手', async () => {
    const { dir, workspace, service } = setup();
    const sub = join(workspace, 'pkg');
    mkdirSync(join(sub, '.codex'), { recursive: true });
    repoHooksFile(workspace, {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }],
    });
    writeFileSync(
      join(sub, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo sub' }] }] } }),
    );
    expect(service.sessionHooks(WS, workspace).hooks).toEqual([]);

    await service.add({ rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm' } });
    await service.add({
      workspaceId: WS,
      rule: { kind: 'stop_check', command: 'pnpm test', timeoutSec: 100 },
    });
    await service.add({
      workspaceId: WS,
      rule: { kind: 'commit_check', command: 'pnpm lint' },
      enabled: false,
    });
    await service.setRepoHookEnabled(WS, '.codex/hooks.json:PreToolUse:0:0', true);

    const { hooks, disabledHooks } = service.sessionHooks(WS, sub);
    const checker = `ELECTRON_RUN_AS_NODE=1 exec '/usr/bin/node' '${join(dir, 'bin', 'wevir-guardrail.mjs')}' '--dir' '${dir}' '--workspace' '${WS}'`;
    expect(hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash|apply_patch', command: checker, timeoutSec: 30 },
      { event: 'Stop', command: checker, timeoutSec: 130 },
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: expect.stringContaining(`'--exec' '${Buffer.from('./x.sh').toString('base64')}'`),
      },
    ]);
    expect(disabledHooks).toEqual([
      `${join(workspace, '.codex', 'hooks.json')}:pre_tool_use:0:0`,
      `${join(sub, '.codex', 'hooks.json')}:stop:0:0`,
    ]);
    // 不在项目里（全局规则）的会话：只有全局规则，没有仓库 hooks 的启用。
    expect(service.sessionHooks(undefined, sub).hooks).toHaveLength(1);
  });
});
