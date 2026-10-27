import type { Session, SessionId, WevirEvent } from '@wevir/protocol';
import { t } from '@/i18n';
import { type AgentActivity, activityOf } from '@/session/agent-status-model';
import type { ToolPart } from '@/session/tool-model';

// 每个会话进行中的回合的当前动作（侧栏的运行行、输入框上方开出的会话）：跟着列表已经在收的事件（workbench-store 的
// onSessionEvent，workbench-data.tsx 建库时接上）走，不另外订阅。只在动作变了时通知这一个会话的监听者，流式回答时别的行不重渲染。打开应用时已经在跑的
// 回合，等下一个事件到了才有动作；在那之前显示“运行中”。

export interface SessionActivity extends AgentActivity {
  /** 这个回合做完的工具调用数。 */
  steps: number;
}

interface Tracked {
  turnId: string;
  running: Map<string, ToolPart>;
  writing: boolean;
  steps: number;
  activity: SessionActivity;
}

export class SessionActivityTracker {
  readonly #turns = new Map<SessionId, Tracked>();
  readonly #listeners = new Map<SessionId, Set<() => void>>();

  get(id: SessionId): SessionActivity | undefined {
    return this.#turns.get(id)?.activity;
  }

  subscribe(id: SessionId, listener: () => void): () => void {
    let set = this.#listeners.get(id);
    if (!set) {
      set = new Set();
      this.#listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(id);
    };
  }

  apply(event: WevirEvent, session: Pick<Session, 'id' | 'cwd'>): void {
    const id = session.id;
    if (
      event.type === 'turn.finished' ||
      (event.type === 'session.state_changed' &&
        (event.payload.to === 'idle' ||
          event.payload.to === 'error' ||
          event.payload.to === 'closed'))
    ) {
      if (this.#turns.delete(id)) this.#notify(id);
      return;
    }
    if (event.type === 'turn.started') {
      this.#turns.set(id, {
        turnId: event.payload.turnId,
        running: new Map(),
        writing: false,
        steps: 0,
        activity: { label: t('work.thinking'), tone: 'running', steps: 0 },
      });
      this.#notify(id);
      return;
    }
    const tracked = this.#turns.get(id);
    if (!tracked) return;
    switch (event.type) {
      case 'tool.started':
        tracked.writing = false;
        tracked.running.set(event.payload.toolCallId, {
          type: 'tool',
          key: event.payload.toolCallId,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          display: event.payload.display,
          status: 'running',
          input: event.payload.input,
          startedAt: event.ts,
        });
        break;
      case 'tool.updated': {
        const part = tracked.running.get(event.payload.toolCallId);
        if (part && event.payload.display)
          tracked.running.set(part.toolCallId, { ...part, display: event.payload.display });
        break;
      }
      case 'tool.finished':
        if (tracked.running.delete(event.payload.toolCallId)) tracked.steps += 1;
        break;
      case 'approval.requested': {
        const part = tracked.running.get(event.payload.approval.toolCallId);
        if (part) tracked.running.set(part.toolCallId, { ...part, status: 'awaiting_approval' });
        break;
      }
      case 'approval.resolved': {
        for (const part of tracked.running.values())
          if (part.status === 'awaiting_approval')
            tracked.running.set(part.toolCallId, { ...part, status: 'running' });
        break;
      }
      case 'assistant.delta':
        tracked.writing = event.payload.kind === 'text' && tracked.running.size === 0;
        break;
      default:
        return;
    }
    const next = this.#activityOf(tracked, session.cwd);
    const current = tracked.activity;
    if (
      next.label === current.label &&
      next.target === current.target &&
      next.tone === current.tone &&
      next.steps === current.steps
    )
      return;
    tracked.activity = next;
    this.#notify(id);
  }

  #activityOf(tracked: Tracked, root: string): SessionActivity {
    const parts = [...tracked.running.values()];
    const live =
      parts.find((part) => part.status === 'awaiting_approval') ?? parts[parts.length - 1];
    const activity: AgentActivity = live
      ? activityOf(live, root)
      : {
          label: tracked.writing ? t('agentStatus.writing') : t('work.thinking'),
          tone: 'running',
        };
    return { ...activity, steps: tracked.steps };
  }

  #notify(id: SessionId): void {
    for (const listener of this.#listeners.get(id) ?? []) listener();
  }
}
