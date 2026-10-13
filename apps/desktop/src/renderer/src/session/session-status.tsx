import type { Transcript } from '@wevir/client-sdk';
import { useEffect, useState } from 'react';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { t } from '@/i18n';
import { formatDuration, truncate } from './format';

/** 错误摘要在状态栏里最多显示的字数（完整原文在提示与消息流的错误卡片里）。 */
const ERROR_SUMMARY_LENGTH = 80;

/**
 * 会话状态指示（输入框底栏左侧）：空闲、运行中（已用时间）、等待审批、正在取消、出错（错误摘要）、已关闭、
 * 只读；空闲时上一轮失败也提示一句。
 */
export function SessionStatus({ transcript }: { transcript: Transcript }) {
  const { state, readOnly, lastError } = transcript;
  const startedAt = useActiveTurnStart(transcript);
  const elapsed = useElapsed(state === 'running' ? startedAt : undefined);

  let tone: StatusTone = 'neutral';
  let pulse = false;
  let text: string;
  let title: string | undefined;
  if (readOnly) {
    tone = 'danger';
    text = t('status.readOnly', { reason: t(`readOnly.${readOnly.reason}`) });
    title = readOnly.message;
  } else {
    switch (state) {
      case 'running':
        tone = 'accent';
        pulse = true;
        text = t('status.running', { elapsed: formatDuration(elapsed ?? 0) });
        break;
      case 'awaiting_approval':
        tone = 'warning';
        text = t('status.awaiting_approval');
        break;
      case 'cancelling':
        tone = 'warning';
        pulse = true;
        text = t('status.cancelling');
        break;
      case 'error':
        tone = 'danger';
        text = `${t('status.error', {
          message: truncate(lastError?.message ?? t('session.state.error'), ERROR_SUMMARY_LENGTH),
        })} · ${t('status.errorHint')}`;
        title = lastError?.message;
        break;
      case 'closed':
        text = t('status.closed');
        break;
      default:
        if (lastError) {
          tone = 'warning';
          text = t('status.lastFailed', {
            message: truncate(lastError.message, ERROR_SUMMARY_LENGTH),
          });
          title = lastError.message;
        } else {
          text = t('status.idle');
        }
    }
  }
  return (
    <p
      role="status"
      data-testid="session-status"
      data-state={state}
      title={title}
      className="flex min-w-0 items-center gap-2 text-muted-foreground"
    >
      <StatusDot tone={tone} pulse={pulse} />
      <span className="truncate">{text}</span>
    </p>
  );
}

function useActiveTurnStart(transcript: Transcript): string | undefined {
  const { activeTurnId, messages } = transcript;
  if (!activeTurnId) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant' && message.turnId === activeTurnId) return message.startedAt;
  }
  return undefined;
}

/** 从 `since` 起的毫秒数，每秒更新一次。 */
function useElapsed(since: string | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - Date.parse(since)) : undefined;
}
