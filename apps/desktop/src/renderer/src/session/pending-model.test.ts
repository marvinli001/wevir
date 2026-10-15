import type { PendingMessage } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ComposerKey,
  canSteerNow,
  composerKeyAction,
  fallbackNote,
  groupPending,
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
    expect(composerKeyAction(key('Tab'), busy)).toBe('send-other');
    expect(composerKeyAction(key('Tab', { shiftKey: true }), busy)).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, busy: false })).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, pendingEnabled: false })).toBe('none');
    expect(composerKeyAction(key('Tab'), { ...busy, hasText: false })).toBe('none');
    expect(composerKeyAction(key('Tab', { composing: true }), busy)).toBe('none');
  });
});
