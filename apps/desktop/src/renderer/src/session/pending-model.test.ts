import type { PendingMessage } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ComposerKey,
  canSteerNow,
  composerKeyAction,
  fallbackNote,
  groupPending,
  noticeLabel,
  otherDelivery,
} from './pending-model';

function pending(n: number, extra: Partial<PendingMessage> = {}): PendingMessage {
  return {
    id: `pnd_01JA2B3C4D5E6F7G8H9JKMNP0${n}`,
    content: [{ type: 'text', text: `消息 ${n}` }],
    delivery: 'queue',
    status: 'waiting',
    sentBy: { deviceId: 'dev', clientId: 'desk', clientKind: 'desktop' },
    createdAt: '2026-10-14T08:00:00.000Z',
    updatedAt: '2026-10-14T08:00:00.000Z',
    ...extra,
  } as PendingMessage;
}

const key = (value: string, extra: Partial<ComposerKey> = {}): ComposerKey => ({
  key: value,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  composing: false,
  ...extra,
});

describe('待发区（R11）', () => {
  it('按插话、排队、暂停分组，组内保持加入的先后；终态的不出现', () => {
    const groups = groupPending([
      pending(1, { delivery: 'steer' }),
      pending(2),
      pending(3, { status: 'held' }),
      pending(4),
      pending(5, { status: 'sent' }),
    ]);
    expect(groups.steer.map((p) => p.id.at(-1))).toEqual(['1']);
    expect(groups.queue.map((p) => p.id.at(-1))).toEqual(['2', '4']);
    expect(groups.held.map((p) => p.id.at(-1))).toEqual(['3']);
  });

  it('别的会话与后台进程发来的消息不算用户的排队消息：单独成组，暂停的留在已暂停里', () => {
    const report = { sessionId: 'ses_X', kind: 'report' } as const;
    const groups = groupPending([
      pending(1),
      pending(2, { from: report }),
      pending(3, { delivery: 'steer', from: { sessionId: 'ses_X', kind: 'message' } }),
      pending(4, { status: 'held', from: report }),
    ]);
    expect(groups.queue.map((p) => p.id.at(-1))).toEqual(['1']);
    expect(groups.steer).toEqual([]);
    expect(groups.notices.map((p) => p.id.at(-1))).toEqual(['2', '3']);
    expect(groups.held.map((p) => p.id.at(-1))).toEqual(['4']);
  });

  it('通知的说明：回报、来自会话、进程退出与匹配', () => {
    const base = { sessionId: 'ses_X' } as const;
    expect(noticeLabel({ ...base, kind: 'report' }, '子任务')).toBe('“子任务”的回报');
    expect(noticeLabel({ ...base, kind: 'message' }, '子任务')).toBe('来自“子任务”');
    const process = { id: 'p1', name: 'dev', event: 'exit', exitCode: 3 };
    expect(noticeLabel({ ...base, kind: 'report', process }, 'x')).toBe(
      '后台进程“dev”已退出（退出码 3）',
    );
    expect(
      noticeLabel({ ...base, kind: 'report', process: { ...process, event: 'match' } }, 'x'),
    ).toBe('后台进程“dev”输出匹配');
  });

  it('“已转为排队”的说明按原因', () => {
    expect(fallbackNote(pending(1))).toBeUndefined();
    expect(fallbackNote(pending(1, { fallback: { reason: 'unsupported' } }))).toBe(
      '引擎不支持插话，已转为排队',
    );
    expect(fallbackNote(pending(1, { fallback: { reason: 'turn_ended' } }))).toContain('转为排队');
  });

  it('能插话的状态；另一种方式', () => {
    expect(canSteerNow('running')).toBe(true);
    expect(canSteerNow('awaiting_approval')).toBe(true);
    expect(canSteerNow('cancelling')).toBe(false);
    expect(canSteerNow('idle')).toBe(false);
    expect(otherDelivery('steer')).toBe('queue');
    expect(otherDelivery('queue')).toBe('steer');
  });
});

describe('输入框按键（R11）', () => {
  const busy = { busy: true, pendingEnabled: true, hasText: true };

  it('Enter 发送，Shift+Enter 与输入法合成中不发送', () => {
    expect(composerKeyAction(key('Enter'), busy)).toBe('send');
    expect(composerKeyAction(key('Enter', { shiftKey: true }), busy)).toBe('none');
    expect(composerKeyAction(key('Enter', { composing: true }), busy)).toBe('none');
  });

  it('Tab 只在回合进行中、Host 支持、有内容时用另一种方式发送，否则照常移动焦点', () => {
    // U35：⌘ / Ctrl + Enter 发送时单按 Enter 换行。
    const mod = { ...busy, sendShortcut: 'mod-enter' as const };
    expect(composerKeyAction(key('Enter'), mod)).toBe('none');
    expect(composerKeyAction(key('Enter', { metaKey: true }), mod)).toBe('send');
    expect(composerKeyAction(key('Enter', { ctrlKey: true }), mod)).toBe('send');
    expect(composerKeyAction(key('Tab'), busy)).toBe('send-other');
    expect(composerKeyAction(key('Tab', { shiftKey: true }), busy)).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, busy: false })).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, pendingEnabled: false })).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, hasText: false })).toBe('none');
    expect(composerKeyAction(key('Tab', { composing: true }), busy)).toBe('none');
  });
});

describe('计划模式的快捷键（0.36.0）', () => {
  const idle = { busy: false, pendingEnabled: true, hasText: false };
  it('Shift+Tab 在能开关计划模式时切换，否则照常移动焦点', () => {
    const shiftTab = {
      key: 'Tab',
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      composing: false,
    };
    expect(composerKeyAction(shiftTab, { ...idle, planToggle: true })).toBe('toggle-plan');
    expect(composerKeyAction(shiftTab, idle)).toBe('none');
    expect(composerKeyAction({ ...shiftTab, composing: true }, { ...idle, planToggle: true })).toBe(
      'none',
    );
    expect(composerKeyAction({ ...shiftTab, metaKey: true }, { ...idle, planToggle: true })).toBe(
      'none',
    );
  });
});
