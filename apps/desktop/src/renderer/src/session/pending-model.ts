import type { PendingDelivery, PendingMessage, SessionState } from '@wevir/protocol';
import { t } from '@/i18n';

// 回合进行中发消息（R11，domain-model §3.3.2、§4.6）的纯逻辑：待发区的分组、说法与输入框的按键。

export interface PendingGroups {
  /** 交给模型、等这一步结束插进本回合的插话：不能再改。 */
  steer: PendingMessage[];
  /** 回合结束后发出的排队消息。 */
  queue: PendingMessage[];
  /** 回合没有正常结束而暂停的，等用户继续发送。 */
  held: PendingMessage[];
}

/** 按 Codex 终端界面的三段分组（`bottom_pane/pending_input_preview.rs`），组内按加入的先后。 */
export function groupPending(pending: readonly PendingMessage[]): PendingGroups {
  const groups: PendingGroups = { steer: [], queue: [], held: [] };
  for (const message of pending) {
    if (message.status === 'held') groups.held.push(message);
    else if (message.status === 'waiting') {
      (message.delivery === 'steer' ? groups.steer : groups.queue).push(message);
    }
  }
  return groups;
}

export function otherDelivery(delivery: PendingDelivery): PendingDelivery {
  return delivery === 'steer' ? 'queue' : 'steer';
}

/** 回合进行中、能插话的状态（正在取消时插话也会转为排队）。 */
export function canSteerNow(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'awaiting_approval';
}

/** “已转为排队”的说明；没有转过时为 undefined。 */
export function fallbackNote(message: PendingMessage): string | undefined {
  const reason = message.fallback?.reason;
  if (reason === undefined) return undefined;
  return t(`pending.fallback.${reason}`);
}

export function pendingText(message: PendingMessage): string {
  return message.content.map((part) => part.text).join('\n');
}

/** 输入框里一次按键要做的事（只看与发送有关的键）。 */
export type ComposerKeyAction = 'send' | 'send-other' | 'none';

export interface ComposerKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** 输入法合成中（含 Safari 合成结束时 keyCode 229）。 */
  composing: boolean;
}

/**
 * Enter 按默认方式发送（空闲时就是发送，回合进行中按“回合进行中按回车”的设置），Shift+Enter 换行；回合进行中、有内容时
 * Tab 用另一种方式发送（照 Codex：回车插话、Tab 排队，维护者 2026-10-14 定），其余时候 Tab 照常移动焦点。
 */
export function composerKeyAction(
  key: ComposerKey,
  context: { busy: boolean; pendingEnabled: boolean; hasText: boolean },
): ComposerKeyAction {
  if (key.composing) return 'none';
  if (key.key === 'Enter' && !key.shiftKey) return 'send';
  const plain = !key.shiftKey && !key.altKey && !key.ctrlKey && !key.metaKey;
  if (key.key === 'Tab' && plain && context.busy && context.pendingEnabled && context.hasText) {
    return 'send-other';
  }
  return 'none';
}
