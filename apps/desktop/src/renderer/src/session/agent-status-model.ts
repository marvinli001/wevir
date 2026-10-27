import { t } from '@/i18n';
import { type ToolPart, toolLine } from './tool-model';

// 进行中的回合的当前动作（侧栏运行中的会话行的第二行，data/session-activity.ts 跟着事件算）：动作的文字与目标，等用户
// 处理时 `awaiting`；以及那一行的计时写法。

/** 当前动作：等审批或回答时 `awaiting`。 */
export interface AgentActivity {
  label: string;
  target?: string;
  tone: 'running' | 'awaiting';
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
