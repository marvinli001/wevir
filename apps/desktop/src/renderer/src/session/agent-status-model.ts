import type { Transcript } from '@wevir/client-sdk';
import type { TurnId } from '@wevir/protocol';
import { t } from '@/i18n';
import { between } from './format';
import { type ToolPart, toolLine, type WorkLineView } from './tool-model';

// 代理状态（输入框上方的状态卡、侧栏的运行行、开出的会话）：进行中的回合在做什么、做过哪几步、各用了多久。照 Arc 的
// Agent status 的信息排布（当前动作、计时、步骤列表），数据来自消息流的投影，不另向 Host 要。

/** 做完的一步：工具调用那一行的文字（同消息流里展开的逐条）与用时。 */
export interface AgentStep {
  key: string;
  label: string;
  target?: string;
  tone: WorkLineView['tone'];
  durationMs?: number;
}

/** 当前动作：等审批或回答时 `awaiting`。 */
export interface AgentActivity {
  label: string;
  target?: string;
  tone: 'running' | 'awaiting';
}

export interface AgentRun {
  turnId: TurnId;
  startedAt?: string;
  current: AgentActivity;
  steps: AgentStep[];
}

/**
 * 进行中的回合的状态；没有进行中的回合时 undefined。当前动作：等回答、等审批的工具、最后一个还在跑的工具，都没有时看回合
 * 最后一段：正在流出的回答是“正在回复”，否则“正在思考”。
 */
export function agentRun(
  transcript: Pick<Transcript, 'messages' | 'activeTurnId' | 'pendingQuestions'>,
  root?: string,
): AgentRun | undefined {
  const turnId = transcript.activeTurnId;
  if (turnId === undefined) return undefined;
  let startedAt: string | undefined;
  const tools: ToolPart[] = [];
  let lastKind: string | undefined;
  for (const message of transcript.messages) {
    if (message.role !== 'assistant' || message.turnId !== turnId) continue;
    startedAt ??= message.startedAt;
    for (const part of message.parts) {
      if (part.type === 'tool') tools.push(part);
      lastKind = part.type === 'text' && part.state === 'streaming' ? 'writing' : part.type;
    }
  }
  const steps: AgentStep[] = [];
  for (const part of tools) {
    if (part.status === 'running' || part.status === 'awaiting_approval') continue;
    const line = toolLine(part, true, root);
    const durationMs = between(part.startedAt, part.finishedAt);
    steps.push({
      key: part.key,
      label: line.label,
      ...(line.target !== undefined && { target: line.target }),
      tone: line.tone,
      ...(durationMs !== undefined && { durationMs }),
    });
  }
  return {
    turnId,
    ...(startedAt !== undefined && { startedAt }),
    current: currentActivity(tools, transcript.pendingQuestions.length > 0, lastKind, root),
    steps,
  };
}

function currentActivity(
  tools: readonly ToolPart[],
  question: boolean,
  lastKind: string | undefined,
  root: string | undefined,
): AgentActivity {
  if (question) return { label: t('work.awaitingInput'), tone: 'awaiting' };
  const waiting = tools.find((tool) => tool.status === 'awaiting_approval');
  const running = waiting ?? tools.findLast((tool) => tool.status === 'running');
  if (running) return activityOf(running, root);
  return {
    label: lastKind === 'writing' ? t('agentStatus.writing') : t('work.thinking'),
    tone: 'running',
  };
}

/** 一个还没结束的工具调用的当前动作：“正在读取 a.ts”；等审批时“等待审批”。 */
export function activityOf(part: ToolPart, root?: string): AgentActivity {
  if (part.status === 'awaiting_approval') {
    const { target } = toolLine({ ...part, status: 'running' }, true, root);
    return { label: t('work.awaiting'), ...(target !== undefined && { target }), tone: 'awaiting' };
  }
  const { label, target } = toolLine(part, true, root);
  return { label, ...(target !== undefined && { target }), tone: 'running' };
}

/** 计时的写法：0:07、1:05、12:30，超过一小时 1:02:03。等宽数字，每秒走一格。 */
export function formatClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}
