import { describe, expect, it } from 'vitest';
import { missingParamPermissions } from './permissions.js';

describe('restored workspace permissions', () => {
  it('requires host management for every restoration or trust parameter', () => {
    const granted = new Set(['session.write', 'workspace.write']);
    for (const extra of [
      {
        workspaceSnapshot: {
          vaultId: 'vault_test',
          entityId: 'entity_test',
          opId: 'operation_test',
        },
      },
      { workspaceRestoreId: 'restore_test' },
      { trustWorkspace: false },
    ])
      expect(
        missingParamPermissions(
          'session.createFromHistory',
          {
            sessionId: 'ses_test',
            ...extra,
          },
          granted,
        ),
      ).toEqual(['host.manage']);
    expect(
      missingParamPermissions(
        'readiness.install',
        {
          workspaceId: 'ws_test',
          planId: 'plan_test',
          acceptScripts: true,
          workspaceRestoreId: 'restore_test',
        },
        granted,
      ),
    ).toEqual(['host.manage']);
  });
});

it('requires policy.write for persistent Codex policy changes', () => {
  const granted = new Set(['session.write']);
  for (const [optionId, expected] of [
    ['accept', []],
    ['codex-policy-1', ['policy.write']],
  ] as const) {
    expect(
      missingParamPermissions('approval.respond', { approvalId: 'apr_test', optionId }, granted),
    ).toEqual(expected);
  }
});
