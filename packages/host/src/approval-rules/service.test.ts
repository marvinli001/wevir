import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SES, SES2, seedSession, T0, useStorages, useTempDir } from '../test-utils.js';
import { ApprovalRuleService, approvalCommand } from './service.js';

const options = [
  { optionId: 'accept', label: '允许', kind: 'allow_accept', category: 'allow' },
  { optionId: 'decline', label: '拒绝', kind: 'reject_decline', category: 'reject' },
];
const desktop = { deviceId: 'dev-1', clientId: 'cli-1', clientKind: 'desktop' };

describe('ApprovalRuleService', () => {
  const tempDir = useTempDir();
  const storages = useStorages();

  function setup() {
    const storage = storages.open(join(tempDir(), 'data'));
    seedSession(storage);
    seedSession(storage, SES2);
    storage.workspaces.insert({
      id: 'ws_2',
      rootPath: '/home/u/other',
      displayName: 'other',
      createdAt: T0,
      updatedAt: T0,
    });
    return { storage, rules: new ApprovalRuleService({ storage }) };
  }

  let n = 0;
  /** 记一条已结算的命令审批。 */
  function approved(
    storage: ReturnType<typeof setup>['storage'],
    command: string,
    at: string,
    reason = 'user',
    sessionId = SES,
  ) {
    n += 1;
    const id = `apr_${n}`;
    storage.approvals.insert({
      id,
      sessionId,
      turnId: 'trn_1',
      toolCallId: `call_${n}`,
      options,
      detail: { toolName: 'exec_command', display: { kind: 'shell', command }, input: { command } },
      status: 'pending',
      createdAt: at,
    });
    storage.approvals.resolve(id, {
      status: 'approved',
      resolvedAt: at,
      resolution: { reason, optionId: 'accept', ...(reason === 'user' && { decidedBy: desktop }) },
    });
  }

  it('add 拒绝不宜作规则的前缀与不存在的项目，同一范围同一前缀只有一条', () => {
    const { rules } = setup();
    for (const prefix of [
      ['git'],
      ['npm'],
      ['bash', '-lc'],
      ['sudo', 'ls'],
      ['rm', 'build'],
      ['python3'],
    ]) {
      expect(() => rules.add(prefix), prefix.join(' ')).toThrow(
        expect.objectContaining({ code: 'INVALID_PARAMS' }),
      );
    }
    expect(() => rules.add(['ls'], 'ws_missing')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }),
    );
    const global = rules.add(['git', 'status']);
    expect(rules.add(['git', 'status']).id).toBe(global.id);
    const project = rules.add(['git', 'status'], 'ws_1');
    expect(project.id).not.toBe(global.id);
    expect(rules.list('ws_2').map((r) => r.id)).toEqual([global.id]);
    expect(rules.list().map((r) => r.id)).toEqual([global.id, project.id]);
  });

  it('match 按项目：全局的与这个项目的规则', () => {
    const { rules } = setup();
    const project = rules.add(['pnpm', 'test'], 'ws_1');
    const global = rules.add(['git', 'status']);
    expect(rules.match('git status && pnpm test --filter host', 'ws_1')).toEqual([
      global.id,
      project.id,
    ]);
    expect(rules.match('pnpm test', 'ws_2')).toBeNull();
    expect(rules.match('git status', undefined)).toEqual([global.id]);
  });

  it('propose：引擎提议的更短前缀能用时用它，否则按启发式；已被允许的段不再提议', () => {
    const { rules } = setup();
    expect(rules.propose('pnpm vitest run src/a.test.ts', 'ws_1', ['pnpm', 'vitest'])).toEqual([
      ['pnpm', 'vitest'],
    ]);
    // 引擎提议的是整条命令：不比命令短，按启发式。
    expect(rules.propose('git status -s', 'ws_1', ['git', 'status', '-s'])).toEqual([
      ['git', 'status'],
    ]);
    // 引擎提议的前缀不宜作规则：按启发式（这里也提议不出来）。
    expect(rules.propose('python3 -c "print(1)"', 'ws_1', ['python3'])).toBeNull();
    rules.add(['git', 'status']);
    expect(rules.propose('git status && git diff', 'ws_1')).toEqual([['git', 'diff']]);
  });

  it('suggest：按项目与前缀归在一起，至少两次手动允许，已被规则允许的不再建议', () => {
    const { storage, rules } = setup();
    approved(storage, 'pnpm test --filter host', '2026-10-13T00:00:01.000Z');
    approved(storage, "bash -lc 'pnpm test'", '2026-10-13T00:00:02.000Z');
    approved(storage, 'pnpm test', '2026-10-13T00:00:03.000Z', 'rule');
    approved(storage, 'git status', '2026-10-13T00:00:04.000Z');
    approved(storage, 'git status -s', '2026-10-13T00:00:05.000Z');
    approved(storage, 'git status', '2026-10-13T00:00:06.000Z');
    approved(storage, 'rm -rf build', '2026-10-13T00:00:07.000Z');
    approved(storage, 'rm -rf build', '2026-10-13T00:00:08.000Z');
    approved(storage, 'cargo build', '2026-10-13T00:00:09.000Z');

    expect(rules.suggest()).toEqual([
      {
        prefix: ['git', 'status'],
        workspaceId: 'ws_1',
        count: 3,
        lastApprovedAt: '2026-10-13T00:00:06.000Z',
        example: 'git status',
      },
      {
        prefix: ['pnpm', 'test'],
        workspaceId: 'ws_1',
        count: 2,
        lastApprovedAt: '2026-10-13T00:00:02.000Z',
        example: "bash -lc 'pnpm test'",
      },
    ]);
    rules.add(['git', 'status'], 'ws_1');
    expect(rules.suggest('ws_1').map((s) => s.prefix)).toEqual([['pnpm', 'test']]);
    expect(rules.suggest('ws_2')).toEqual([]);
  });

  it('approvalCommand 只认命令一类、带命令原文的工具', () => {
    expect(
      approvalCommand({
        display: { kind: 'shell', command: 'ls' },
        input: { command: "zsh -lc 'ls'" },
      }),
    ).toBe("zsh -lc 'ls'");
    expect(
      approvalCommand({
        display: { kind: 'shell', command: 'ls -la' },
        input: { command: ['ls', '-la'] },
      }),
    ).toBe('ls -la');
    expect(approvalCommand({ display: { kind: 'shell', command: 'ls' } })).toBe('ls');
    expect(
      approvalCommand({ display: { kind: 'read', paths: ['/x'] }, input: { command: 'cat /x' } }),
    ).toBeUndefined();
    expect(
      approvalCommand({
        display: { kind: 'unknown', command: 'click' },
        input: { command: 'click' },
      }),
    ).toBeUndefined();
  });
});
