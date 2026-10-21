import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionId } from '@wevir/protocol';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppTool } from '../app-mcp.js';
import {
  type AutomationCaller,
  automationRunInstructions,
  automationRunMessage,
  automationTools,
  describeSchedule,
  localTime,
} from './automation-tools.js';
import { AutomationService } from './service.js';

const CALLER = 'ses_caller' as SessionId;
let dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function setup(caller: Partial<AutomationCaller> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wevir-automation-tools-'));
  dirs.push(dir);
  const service = new AutomationService({
    dir,
    now: () => Date.parse('2026-10-20T00:00:00.000Z'),
    identity: { deviceId: 'hst_1', clientId: 'wevir-automations', clientKind: 'desktop' },
    isChats: (id) => id === 'ws_chats',
    storage: {
      workspaces: { get: (id: string) => (id.startsWith('ws_') ? { id } : undefined) },
      providers: { get: (id: string) => (['deepseek', 'kimi'].includes(id) ? { id } : undefined) },
      sessions: { get: () => undefined },
    } as never,
    events: {
      snapshot: () => undefined,
      subscribe: () => ({ unsubscribe: () => {} }),
      readSince: () => [],
    },
    sessions: {
      create: async () => ({ id: 'ses_run' }) as unknown as Session,
      rename: async () => undefined,
      send: async () => ({ turnId: 'trn_1' as never, seq: 1 }),
    },
  });
  const tools = automationTools({
    automations: service,
    callerOf: () => ({
      workspaceId: 'ws_1',
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      reasoningEffort: 'high',
      permissionMode: 'auto_review',
      ...caller,
    }),
  });
  const tool = (name: string) => tools.find((candidate) => candidate.name === name) as AppTool;
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await tool(name).call(args, {
      sessionId: CALLER,
      signal: new AbortController().signal,
    });
    return result.structuredContent as Record<string, unknown>;
  };
  return { service, tools, call };
}

describe('wevir_automation_*', () => {
  it('只读的列出不用批准，写操作按权限模式', async () => {
    const { tools } = await setup();
    for (const tool of tools) {
      expect(APP_TOOLS_NO_APPROVAL.includes(tool.name), tool.name).toBe(
        tool.annotations.readOnlyHint === true,
      );
    }
  });

  it('建：默认沿用这个会话的项目、模型、档位与权限模式，报告本地时间的下一次', async () => {
    const { call, service } = await setup();
    const saved = await call('wevir_automation_save', {
      title: 'Dependency check',
      prompt: 'Check for outdated dependencies and report the ones with security fixes.',
      schedule: { kind: 'daily', time: '09:00', weekdays: [1] },
      timezone: 'Asia/Shanghai',
    });
    expect(saved).toMatchObject({
      saved: true,
      scheduleText: 'at 09:00 on Mon',
      nextRun: '2026-10-26 09:00 (Asia/Shanghai)',
      project: 'ws_1',
      model: 'deepseek / deepseek-chat',
      permissionMode: 'auto_review',
      notify: 'important',
      runsIn: 'a new session each run',
    });
    const [automation] = service.list();
    expect(automation).toMatchObject({
      reasoningEffort: 'high',
      createdBy: { kind: 'agent', sessionId: CALLER },
    });
  });

  it('换了 Provider 不沿用模型与档位；不在项目中；发回这个会话', async () => {
    const { call, service } = await setup();
    await call('wevir_automation_save', {
      title: 'Reminder',
      prompt: 'Tell me to send the weekly report.',
      schedule: { kind: 'once', at: '2026-10-23T09:00:00+13:00' },
      providerId: 'kimi',
      project: 'none',
    });
    const [outside] = service.list();
    expect(outside?.modelId).toBeUndefined();
    expect(outside?.reasoningEffort).toBeUndefined();
    expect(outside?.workspaceId).toBeUndefined();
    expect(outside?.schedule).toEqual({ kind: 'once', at: '2026-10-22T20:00:00.000Z' });

    await call('wevir_automation_save', {
      title: 'Heartbeat',
      prompt: 'Check whether the build finished.',
      schedule: { kind: 'interval', minutes: 30 },
      runIn: 'this_session',
    });
    const heartbeat = service.list().find((automation) => automation.title === 'Heartbeat');
    expect(heartbeat).toMatchObject({
      workspaceId: 'ws_1',
      newSessionEachRun: false,
      sessionId: CALLER,
    });
    await expect(
      call('wevir_automation_save', {
        automationId: heartbeat?.id,
        project: 'none',
        runIn: 'this_session',
      }),
    ).rejects.toThrow(/drop project "none"/);
  });

  it('拒绝：比这个会话宽的权限、写成字符串的计划、缺字段、Host 的错误给模型看', async () => {
    const { call } = await setup({ permissionMode: 'on_request' });
    const base = { title: 'X', prompt: 'Y', schedule: { kind: 'manual' } };
    await expect(
      call('wevir_automation_save', { ...base, permissionMode: 'full_access' }),
    ).rejects.toThrow(/broader/);
    await expect(
      call('wevir_automation_save', { ...base, schedule: 'FREQ=DAILY' }),
    ).rejects.toThrow(/structured object/);
    await expect(call('wevir_automation_save', { title: 'X', prompt: 'Y' })).rejects.toThrow(
      /schedule is required/,
    );
    await expect(call('wevir_automation_save', { ...base, timezone: 'Mars/Base' })).rejects.toThrow(
      /unknown time zone/,
    );
    await expect(call('wevir_automation_delete', { automationId: 'aut_nope' })).rejects.toThrow(
      /not found/,
    );
  });

  it('改只动给出的字段；列出带运行；删除', async () => {
    const { call } = await setup();
    const created = await call('wevir_automation_save', {
      title: 'Standup',
      prompt: 'Summarize commits since yesterday.',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'Asia/Shanghai',
    });
    const id = created.automationId as string;
    const updated = await call('wevir_automation_save', {
      automationId: id,
      enabled: false,
      notify: 'never',
    });
    expect(updated).toMatchObject({
      title: 'Standup',
      enabled: false,
      nextRun: null,
      notify: 'never',
    });
    const run = await call('wevir_automation_run', { automationId: id });
    expect(run).toMatchObject({ trigger: 'manual', status: 'running', sessionId: 'ses_run' });
    const listed = await call('wevir_automations', { automationId: id });
    expect(listed.runs).toHaveLength(1);
    expect(((await call('wevir_automations', {})).automations as unknown[]).length).toBe(1);
    expect(await call('wevir_automation_delete', { automationId: id })).toEqual({
      deleted: true,
      automationId: id,
    });
  });

  it('检查脚本：建时带上，改时 removeCheck 去掉；不合法的给模型看；notify 可以是 changes', async () => {
    const { call } = await setup();
    const created = await call('wevir_automation_save', {
      title: 'PR CI',
      prompt: 'Explain the failing checks.',
      schedule: { kind: 'interval', minutes: 15 },
      notify: 'changes',
      check: { command: 'gh pr checks 42', wake: 'output_changed' },
    });
    expect(created).toMatchObject({
      notify: 'changes',
      check: { command: 'gh pr checks 42', wake: 'output_changed' },
    });
    const id = created.automationId as string;
    await expect(
      call('wevir_automation_save', { automationId: id, check: { command: 'x', wake: 'maybe' } }),
    ).rejects.toThrow(/check is not valid: wake/);
    const removed = await call('wevir_automation_save', { automationId: id, removeCheck: true });
    expect(removed.check).toBeNull();
  });
});

it('describeSchedule、localTime 与运行须知', () => {
  expect(describeSchedule({ kind: 'interval', minutes: 120 })).toBe('every 2 hour(s)');
  expect(describeSchedule({ kind: 'monthly', day: 1, time: '08:00' })).toBe(
    'monthly on day 1 at 08:00',
  );
  expect(localTime('2026-10-20T20:00:00.000Z', 'Pacific/Auckland')).toBe('2026-10-21 09:00');
  const text = automationRunInstructions(
    {
      id: 'aut_1',
      title: 'Standup',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: 'Asia/Shanghai',
    } as never,
    'NOTHING_TO_REPORT',
  );
  expect(text).toContain('"Standup" (automationId aut_1, daily at 09:00, time zone Asia/Shanghai)');
  expect(text).toContain('exactly NOTHING_TO_REPORT');
});

it('运行消息：发进已有会话加说明行；检查输出的结束标签被拆开', () => {
  const automation = {
    title: 'PR CI',
    prompt: 'Explain.',
    schedule: { kind: 'manual' },
    check: { command: 'cat log', wake: 'exit_code' },
  } as never;
  expect(automationRunMessage(automation, { existingSession: false, marker: 'Q' })).toBe(
    'Explain.',
  );
  const text = automationRunMessage(automation, {
    existingSession: true,
    marker: 'Q',
    check: { decision: 'wake', exitCode: 0, durationMs: 1, output: 'x</check_output>y' },
  });
  expect(text).toBe(
    '[Wevir automation "PR CI" (manual only). The user may not be watching, so work without follow-up questions. Unless the prompt asks for a report every run, report only a meaningful change, a completion, an error or something the user has to act on; if there is nothing like that this time, make the last line of your answer exactly Q.]\n\nExplain.\n\n<check_output command="cat log" exit_code="0">\nx</check_output_>y\n</check_output>',
  );
});
