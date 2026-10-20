import type { Automation, AutomationRun, AutomationSchedule } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  type AutomationDraft,
  createParams,
  draftOfAutomation,
  draftOfSchedule,
  draftProblem,
  formatMoment,
  groupAutomations,
  runTargetOf,
  scheduleOfDraft,
  scheduleText,
  shouldNotify,
  stateOf,
  updateParams,
  withRunTarget,
  zonedTimeToUtc,
} from './automations-model';

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const TZ = 'Asia/Shanghai';

function automation(patch: Partial<Automation> = {}): Automation {
  return {
    id: 'aut_1' as never,
    title: 'Standup',
    prompt: 'Summarize.',
    schedule: { kind: 'daily', time: '09:00' },
    timezone: TZ,
    enabled: true,
    providerId: 'deepseek' as never,
    permissionMode: 'on_request',
    newSessionEachRun: true,
    notify: 'important',
    createdBy: { kind: 'user' },
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    runCount: 0,
    ...patch,
  };
}

function run(patch: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'arn_1' as never,
    automationId: 'aut_1' as never,
    trigger: 'schedule',
    status: 'completed',
    startedAt: '2026-10-20T01:00:00.000Z',
    ...patch,
  };
}

describe('“重复”预设与计划', () => {
  it.each<[AutomationSchedule, string]>([
    [{ kind: 'manual' }, 'manual'],
    [{ kind: 'interval', minutes: 60 }, 'hourly'],
    [{ kind: 'interval', minutes: 30 }, 'interval'],
    [{ kind: 'daily', time: '09:00' }, 'daily'],
    [{ kind: 'daily', time: '09:00', weekdays: [1, 2, 3, 4, 5] }, 'weekdays'],
    [{ kind: 'daily', time: '09:00', weekdays: [1, 3] }, 'weekly'],
    [{ kind: 'monthly', time: '08:00', day: 31 }, 'monthly'],
    [{ kind: 'once', at: '2026-10-23T01:00:00.000Z' }, 'once'],
  ])('%j 往返不变', (schedule, repeat) => {
    const draft = draftOfSchedule(schedule, TZ, NOW);
    expect(draft.repeat).toBe(repeat);
    expect(scheduleOfDraft(draft, TZ)).toEqual(schedule);
  });

  it('一次的时刻按时区的墙上时间，每周没选日子时不能保存', () => {
    const draft = draftOfSchedule({ kind: 'daily', time: '09:00' }, TZ, NOW);
    expect(scheduleOfDraft({ ...draft, repeat: 'once', at: '2026-10-23T09:00' }, TZ)).toEqual({
      kind: 'once',
      at: '2026-10-23T01:00:00.000Z',
    });
    expect(scheduleOfDraft({ ...draft, repeat: 'weekly', weekdays: [] }, TZ)).toBeUndefined();
    expect(
      scheduleOfDraft({ ...draft, repeat: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] }, TZ),
    ).toEqual({ kind: 'daily', time: '09:00' });
  });

  it('夏令时：跳过的时刻落到之后', () => {
    expect(
      new Date(
        zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
      ).toISOString(),
    ).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('写法', () => {
  it('计划', () => {
    expect(scheduleText({ kind: 'daily', time: '09:00' }, TZ)).toBe('每天 09:00');
    expect(scheduleText({ kind: 'daily', time: '09:00', weekdays: [5, 1, 2, 3, 4] }, TZ)).toBe(
      '工作日 09:00',
    );
    expect(scheduleText({ kind: 'daily', time: '09:00', weekdays: [3, 1] }, TZ)).toBe(
      '每周一、周三 09:00',
    );
    expect(scheduleText({ kind: 'interval', minutes: 120 }, TZ)).toBe('每 2 小时');
    expect(scheduleText({ kind: 'interval', minutes: 45 }, TZ)).toBe('每 45 分钟');
    expect(scheduleText({ kind: 'monthly', day: 1, time: '08:00' }, TZ)).toBe('每月 1 日 08:00');
  });

  it('时刻：今天、明天、一周内写星期', () => {
    expect(formatMoment(Date.parse('2026-10-20T01:00:00.000Z'), TZ, NOW)).toBe('今天 09:00');
    expect(formatMoment(Date.parse('2026-10-21T01:00:00.000Z'), TZ, NOW)).toBe('明天 09:00');
    expect(formatMoment(Date.parse('2026-10-23T01:00:00.000Z'), TZ, NOW)).toBe('周五 09:00');
  });
});

it('分组：即将执行按下一次的先后，再是手动、已暂停、已完成', () => {
  const groups = groupAutomations([
    automation({ id: 'aut_late' as never, nextRunAt: '2026-10-22T01:00:00.000Z' }),
    automation({ id: 'aut_paused' as never, enabled: false }),
    automation({ id: 'aut_manual' as never, schedule: { kind: 'manual' } }),
    automation({ id: 'aut_soon' as never, nextRunAt: '2026-10-20T01:00:00.000Z' }),
    automation({
      id: 'aut_done' as never,
      schedule: { kind: 'once', at: '2026-10-19T01:00:00.000Z' },
    }),
  ]);
  expect(groups.map(({ group, automations }) => [group, automations.map((a) => a.id)])).toEqual([
    ['upcoming', ['aut_soon', 'aut_late']],
    ['manual', ['aut_manual']],
    ['paused', ['aut_paused']],
    ['finished', ['aut_done']],
  ]);
  expect(stateOf(automation({ enabled: false, lastRun: run({ status: 'waiting' }) }))).toBe(
    'waiting',
  );
});

it('提醒：等待处理与失败除了“从不”都提醒，完成看设置与无事可报', () => {
  expect(shouldNotify('failures', run({ status: 'waiting' }))).toBe(true);
  expect(shouldNotify('never', run({ status: 'failed' }))).toBe(false);
  expect(shouldNotify('important', run({}))).toBe(true);
  expect(shouldNotify('important', run({ quiet: true }))).toBe(false);
  expect(shouldNotify('always', run({ quiet: true }))).toBe(true);
  expect(shouldNotify('failures', run({}))).toBe(false);
  expect(shouldNotify('always', run({ status: 'skipped' }))).toBe(false);
  // 仅有变化（0.73.0）：与上次相同、无事可报都不提醒；检查脚本没唤醒的不提醒。
  expect(shouldNotify('changes', run({}))).toBe(true);
  expect(shouldNotify('changes', run({ unchanged: true }))).toBe(false);
  expect(shouldNotify('changes', run({ quiet: true }))).toBe(false);
  expect(shouldNotify('changes', run({ status: 'failed' }))).toBe(true);
  expect(shouldNotify('always', run({ status: 'silent' }))).toBe(false);
  expect(stateOf(automation({ lastRun: run({ status: 'checking' }) }))).toBe('running');
});

describe('表单', () => {
  const draft: AutomationDraft = {
    ...draftOfAutomation(automation(), NOW),
    model: { providerId: 'kimi', modelId: 'k2', reasoningEffort: 'high' },
    workspaceId: 'ws_1',
  };

  it('建：带上模型、档位与项目', () => {
    expect(createParams(draft)).toMatchObject({
      title: 'Standup',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: TZ,
      workspaceId: 'ws_1',
      providerId: 'kimi',
      modelId: 'k2',
      reasoningEffort: 'high',
    });
    expect(draftProblem({ ...draft, title: ' ' })).toBe('title');
    expect(draftProblem(draft)).toBeUndefined();
  });

  it('改：清掉的项目与档位传 null', () => {
    const { workspaceId: _, ...outside } = draft;
    const params = updateParams(automation(), {
      ...outside,
      model: { providerId: 'kimi', modelId: 'k2' },
    });
    expect(params).toMatchObject({ workspaceId: null, reasoningEffort: null, modelId: 'k2' });
    expect(params?.check).toBeNull();
    expect(params).not.toHaveProperty('sessionId');
    expect(updateParams(automation(), draft, false)).not.toHaveProperty('check');
  });

  it('发进已有会话：不带项目与模型；会话没换不传 sessionId；改回新会话传 null', () => {
    const inSession = withRunTarget(draft, 'ses_mine');
    expect(runTargetOf(inSession)).toBe('ses_mine');
    expect(createParams({ ...inSession, model: undefined })).toEqual({
      title: 'Standup',
      prompt: 'Summarize.',
      schedule: { kind: 'daily', time: '09:00' },
      timezone: TZ,
      enabled: true,
      permissionMode: 'on_request',
      notify: 'important',
      sessionId: 'ses_mine',
    });
    expect(draftProblem({ ...inSession, model: undefined })).toBeUndefined();
    const bound = automation({ newSessionEachRun: false, sessionId: 'ses_mine' as never });
    const edited = updateParams(bound, draftOfAutomation(bound, NOW));
    expect(edited).not.toHaveProperty('sessionId');
    expect(edited).not.toHaveProperty('workspaceId');
    const fresh = withRunTarget(draftOfAutomation(bound, NOW), 'new');
    expect(updateParams(bound, { ...fresh, model: draft.model })).toMatchObject({
      sessionId: null,
      newSessionEachRun: true,
    });
  });

  it('检查脚本：去掉命令两头空白，命令为空时不能保存', () => {
    const checked = {
      ...draft,
      check: { command: ' gh pr checks 1 ', wake: 'output_changed' as const },
    };
    expect(createParams(checked)?.check).toEqual({
      command: 'gh pr checks 1',
      wake: 'output_changed',
    });
    expect(draftProblem({ ...draft, check: { command: ' ', wake: 'exit_code' } })).toBe('check');
  });
});
