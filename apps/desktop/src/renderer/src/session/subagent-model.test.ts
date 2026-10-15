import type { ChatPart } from '@wevir/client-sdk';
import type { ApprovalRequest, SessionId, SubagentSummary } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  elapsedText,
  formatRelativeTime,
  groupSubagents,
  markerText,
  modelLine,
  pendingApprovals,
  statusLabel,
  subagentTitle,
  visibleParts,
} from './subagent-model';
import type { ToolPart } from './tool-model';

const T0 = Date.parse('2026-10-14T08:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function child(n: number, extra: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    sessionId: `ses_01JA2B3C4D5E6F7G8H9JKMNP0${n}` as SessionId,
    parentToolCallId: `call_spawn_${n}`,
    title: `Task ${n}`,
    modelId: 'deepseek-chat',
    status: 'running',
    startedAt: at(n),
    pendingApprovals: [],
    ...extra,
  };
}

function tool(id: string, extra: Partial<ToolPart> = {}): ToolPart {
  return {
    type: 'tool',
    key: `t:${id}`,
    toolCallId: id,
    toolName: 'collabAgentToolCall.wait',
    display: { kind: 'sub_agent' },
    status: 'completed',
    input: {},
    startedAt: at(0),
    ...extra,
  };
}

function approval(id: string, createdAt: string): ApprovalRequest {
  return {
    id: `apr_01JA2B3C4D5E6F7G8H9JKMNP${id}`,
    sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPAA',
    turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPAA',
    toolCallId: `call_${id}`,
    options: [{ optionId: 'allow', label: 'Allow once', kind: 'allow_once', category: 'allow' }],
    detail: null,
    status: 'pending',
    createdAt,
  };
}

describe('标题与状态的说法', () => {
  it('标题：Host 给的标题 → 昵称 → “子智能体”', () => {
    expect(subagentTitle({ title: 'Text patch review' })).toBe('Text patch review');
    expect(subagentTitle({ title: '  ', nickname: 'Robie' })).toBe('Robie');
    expect(subagentTitle({ title: '' })).toBe('子智能体');
  });

  it('开始与结束两行，结束按当时的状态', () => {
    const summary = { title: 'Text boundary investigation' };
    expect(markerText(summary)).toBe('Text boundary investigation已启动');
    expect(markerText(summary, 'completed')).toBe('Text boundary investigation已完成');
    expect(markerText(summary, 'failed')).toBe('Text boundary investigation运行失败');
    expect(markerText(summary, 'closed')).toBe('Text boundary investigation已关闭');
    expect(markerText(summary, 'cancelled')).toBe('Text boundary investigation已取消');
    expect(statusLabel('running')).toBe('运行中');
  });

  it('模型 · 推理强度：认识的级别本地化，不认识的原样，没有就只有模型', () => {
    expect(modelLine({ modelId: 'deepseek-v4-pro', reasoningEffort: 'high' })).toBe(
      'deepseek-v4-pro · 推理力度 高',
    );
    expect(modelLine({ modelId: 'm', reasoningEffort: 'medium' })).toBe('m · 推理力度 中');
    expect(modelLine({ modelId: 'm', reasoningEffort: 'off' })).toBe('m · 不推理');
    expect(modelLine({ modelId: 'm', reasoningEffort: 'turbo' })).toBe('m · 推理力度 turbo');
    expect(modelLine({ modelId: 'm' })).toBe('m');
  });
});

describe('“子智能体”窗格', () => {
  it('分成已开启与完成两组，组内最近的在前', () => {
    const a = child(1, { status: 'completed', endedAt: at(50) });
    const b = child(2);
    const c = child(3, { status: 'failed', endedAt: at(80) });
    const d = child(4);
    const e = child(5, { status: 'closed', endedAt: at(60) });
    const { open, done } = groupSubagents([a, b, c, d, e]);
    expect(open.map((s) => s.title)).toEqual(['Task 4', 'Task 2']);
    expect(done.map((s) => s.title)).toEqual(['Task 3', 'Task 5', 'Task 1']);
    expect(groupSubagents([])).toEqual({ open: [], done: [] });
  });

  it('时刻相同时后派出的在前', () => {
    const a = child(1, { startedAt: at(0) });
    const b = child(2, { startedAt: at(0) });
    expect(groupSubagents([a, b]).open.map((s) => s.title)).toEqual(['Task 2', 'Task 1']);
  });

  it('相对时间', () => {
    const now = T0 + 10_000;
    expect(formatRelativeTime(at(0), now)).toBe('刚刚');
    expect(formatRelativeTime(at(20), now)).toBe('刚刚');
    expect(formatRelativeTime(at(0), T0 + 5 * 60_000)).toBe('5 分钟前');
    expect(formatRelativeTime(at(0), T0 + 65 * 60_000)).toBe('1 小时前');
    expect(formatRelativeTime(at(0), T0 + 49 * 3_600_000)).toBe('2 天前');
    expect(formatRelativeTime('not a time', now)).toBe('刚刚');
  });

  it('用时：结束的按起止时刻，运行中的算到现在', () => {
    expect(elapsedText(child(0, { status: 'completed', endedAt: at(194) }), T0 + 999_000)).toBe(
      '用时 3 分 14 秒',
    );
    expect(elapsedText(child(0), T0 + 12_000)).toBe('运行中 · 已用 12 秒');
  });
});

describe('父会话的消息流', () => {
  const marker = (summary: SubagentSummary): ChatPart => ({
    type: 'subagent',
    key: `a:${summary.sessionId}`,
    subagent: summary,
  });
  const text: ChatPart = { type: 'text', key: 'x', text: 'x', state: 'done' };

  it('派出子会话的调用与其余的 collab 调用都藏起来，失败的除外', () => {
    const spawned = child(1);
    const spawn = tool('call_spawn_1', { toolName: 'collabAgentToolCall.spawnAgent' });
    const wait = tool('call_wait');
    const failed = tool('call_spawn_x', { status: 'failed' });
    const shell = tool('call_shell', { display: { kind: 'shell' } });
    const parts = [spawn, marker(spawned), text, wait, failed, shell];
    expect(visibleParts(parts, true)).toEqual([marker(spawned), text, failed, shell]);
  });

  it('没有子会话的会话（dsh）照常显示子 agent 的工具卡片', () => {
    const parts = [tool('call_dsh_subagent', { toolName: 'subagent' }), text];
    expect(visibleParts(parts, false)).toBe(parts);
  });

  it('子会话的摘要还没到时，同一条消息里派出它的调用也会藏起来', () => {
    const parts = [tool('call_spawn_1'), marker(child(1)), tool('call_wait')];
    expect(visibleParts(parts, false)).toEqual([marker(child(1)), tool('call_wait')]);
  });

  it('输入框上方的审批：会话自己的与子会话的合在一起，按请求的先后，来自子会话的带上它', () => {
    const own = approval('01', at(30));
    const fromChild = approval('02', at(10));
    const helper = child(1, { pendingApprovals: [fromChild] });
    const items = pendingApprovals({ pendingApprovals: [own], subagents: [helper, child(2)] });
    expect(items).toEqual([{ approval: fromChild, subagent: helper }, { approval: own }]);
  });
});
