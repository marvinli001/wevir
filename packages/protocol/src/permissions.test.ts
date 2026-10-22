import { describe, expect, it } from 'vitest';
import {
  METHOD_NAMES,
  MethodSchemas,
  NOTIFICATION_NAMES,
  NOTIFICATION_PERMISSIONS,
  PERMISSIONS,
} from './index.js';

const known = new Set<string>(PERMISSIONS);

describe('权限表', () => {
  it('每个方法的权限都在词表里（null 只给握手与心跳）', () => {
    for (const method of METHOD_NAMES) {
      const permission = MethodSchemas[method].permission;
      if (permission === null) expect(['host.hello', 'host.ping'], method).toContain(method);
      else expect(known.has(permission), method).toBe(true);
    }
  });

  it('每个通知都登记了读权限，且在词表里', () => {
    expect(Object.keys(NOTIFICATION_PERMISSIONS).sort()).toEqual([...NOTIFICATION_NAMES].sort());
    for (const name of NOTIFICATION_NAMES) {
      expect(known.has(NOTIFICATION_PERMISSIONS[name]), name).toBe(true);
    }
  });

  it('终端写方法要 terminal.write，读输出仍是 session.read', () => {
    for (const method of [
      'terminal.create',
      'terminal.input',
      'terminal.resize',
      'terminal.close',
    ] as const) {
      expect(MethodSchemas[method].permission, method).toBe('terminal.write');
    }
    for (const method of ['terminal.list', 'terminal.attach', 'terminal.detach'] as const) {
      expect(MethodSchemas[method].permission, method).toBe('session.read');
    }
    expect(NOTIFICATION_PERMISSIONS['terminal.output']).toBe('session.read');
  });

  it('审批规则、护栏与仓库 hooks 的写方法要 policy.write', () => {
    for (const method of [
      'approvalRule.add',
      'approvalRule.delete',
      'guardrail.add',
      'guardrail.update',
      'guardrail.delete',
      'guardrail.setEnabled',
      'repoHook.setEnabled',
    ] as const) {
      expect(MethodSchemas[method].permission, method).toBe('policy.write');
    }
  });
});
