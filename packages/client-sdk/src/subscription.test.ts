import { WevirEventEnvelopeSchema } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SessionFeed, type SubscriptionItem } from './subscription.js';
import { event, SES } from './test-utils.js';

function feed(sinceSeq = 0) {
  const onClose = vi.fn();
  const onWarning = vi.fn();
  return { feed: new SessionFeed(SES, sinceSeq, { onClose, onWarning }), onClose, onWarning };
}

function apply(target: SessionFeed, raw: ReturnType<typeof event>) {
  return target.apply(raw, WevirEventEnvelopeSchema.parse(raw));
}

/**
 * 读出已经产出的全部项（不等待）。读空时会留下一个挂起的 `next()`，它会吃掉下一项，所以只在用例末尾、
 * 或 `finish()` / `fail()` 之后用。
 */
async function drain(target: SessionFeed): Promise<SubscriptionItem[]> {
  const items: SubscriptionItem[] = [];
  for (;;) {
    const next = await Promise.race([target.next(), Promise.resolve('pending' as const)]);
    if (next === 'pending' || next.done) return items;
    items.push(next.value);
  }
}

function summary(items: SubscriptionItem[]): string[] {
  return items.map((item) =>
    item.type === 'event'
      ? `event ${item.event.seq}`
      : item.type === 'caught_up'
        ? `caught_up ${item.seq}`
        : 'reset',
  );
}

describe('SessionFeed：按 seq 应用事件', () => {
  it('seq == lastSeq + 1 接受；<= lastSeq 是重复；更大是缺口，不推进 lastSeq', async () => {
    const { feed: f } = feed();
    expect(f.attach('sub_1', 5)).toBe('attached');
    expect(apply(f, event(1))).toBe('applied');
    expect(apply(f, event(2))).toBe('applied');
    expect(apply(f, event(2))).toBe('duplicate');
    expect(apply(f, event(1))).toBe('duplicate');
    expect(apply(f, event(4))).toBe('gap');
    expect(f.lastSeq).toBe(2);
    expect(apply(f, event(3))).toBe('applied');
    expect(summary(await drain(f))).toEqual(['event 1', 'event 2', 'event 3']);
  });

  it('不认识的事件类型忽略内容、照常推进 lastSeq；认识的类型 payload 不合 schema 时告警并跳过', async () => {
    const { feed: f, onWarning } = feed();
    f.attach('sub_1', 3);
    expect(apply(f, event(1, 'session.renamed_in_the_future'))).toBe('applied');
    expect(apply(f, { ...event(2, 'turn.started'), payload: { turnId: 42 } })).toBe('applied');
    expect(apply(f, event(3))).toBe('applied');
    expect(f.lastSeq).toBe(3);
    expect(summary(await drain(f))).toEqual(['event 3', 'caught_up 3']);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[1]).toMatchObject({ seq: 2, type: 'turn.started' });
  });

  it('应用到 replayedThroughSeq 才算追平；caught_up 只产出一次，重连后的补发对上层透明', async () => {
    const { feed: f } = feed();
    f.attach('sub_1', 2);
    expect(f.caughtUp).toBe(false);
    apply(f, event(1));
    expect(f.caughtUp).toBe(false);
    apply(f, event(2));
    expect(f.caughtUp).toBe(true);
    apply(f, event(3));
    // 断线：重新订阅时 Host 已经到了 5。
    f.detach();
    expect(f.caughtUp).toBe(false);
    f.attach('sub_2', 5);
    expect(f.caughtUp).toBe(false);
    apply(f, event(4));
    apply(f, event(5));
    expect(f.caughtUp).toBe(true);
    expect(summary(await drain(f))).toEqual([
      'event 1',
      'event 2',
      'caught_up 2',
      'event 3',
      'event 4',
      'event 5',
    ]);
  });

  it('sinceSeq >= replayedThroughSeq 时一订阅就已追平', async () => {
    const { feed: f } = feed(7);
    f.attach('sub_1', 7);
    expect(f.caughtUp).toBe(true);
    expect(summary(await drain(f))).toEqual(['caught_up 7']);
  });

  it('本地 lastSeq 比 Host 新时 attach 返回 reset、不登记；reset() 产出 reset 并从 0 重来', async () => {
    const { feed: f } = feed(9);
    expect(f.attach('sub_1', 4)).toBe('reset');
    expect(f.serverId).toBeUndefined();
    f.reset();
    expect(f.lastSeq).toBe(0);
    f.attach('sub_2', 1);
    apply(f, event(1));
    expect(summary(await drain(f))).toEqual(['reset', 'event 1', 'caught_up 1']);
  });
});

describe('SessionFeed：异步迭代', () => {
  it('没有项时 next() 等待，产出后按序交付', async () => {
    const { feed: f } = feed();
    f.attach('sub_1', 0);
    expect((await f.next()).value).toEqual({ type: 'caught_up', seq: 0 });
    const first = f.next();
    const second = f.next();
    apply(f, event(1));
    apply(f, event(2));
    expect((await first).value).toMatchObject({ type: 'event', event: { seq: 1 } });
    expect((await second).value).toMatchObject({ type: 'event', event: { seq: 2 } });
  });

  it('break 出 for await 即关闭订阅（通知客户端退订），之后的事件不再产出', async () => {
    const { feed: f, onClose } = feed();
    f.attach('sub_1', 0);
    apply(f, event(1));
    for await (const item of f) {
      if (item.type === 'event') break;
    }
    expect(onClose).toHaveBeenCalledWith(f);
    expect(f.ended).toBe(true);
    apply(f, event(2));
    expect(await f.next()).toEqual({ done: true, value: undefined });
  });

  it('finish()：已产出的项仍可读完，之后结束；不通知客户端', async () => {
    const { feed: f, onClose } = feed();
    f.attach('sub_1', 1);
    apply(f, event(1));
    f.finish();
    expect(summary(await drain(f))).toEqual(['event 1', 'caught_up 1']);
    expect(await f.next()).toEqual({ done: true, value: undefined });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fail()：读完已产出的项后以该错误 reject 一次，之后结束；正在等的 next() 直接 reject', async () => {
    const { feed: f } = feed();
    f.attach('sub_1', 5);
    apply(f, event(1));
    const error = new Error('boom');
    f.fail(error);
    expect((await f.next()).value).toMatchObject({ event: { seq: 1 } });
    await expect(f.next()).rejects.toBe(error);
    expect(await f.next()).toEqual({ done: true, value: undefined });

    const { feed: g } = feed();
    const waiting = g.next();
    g.fail(error);
    await expect(waiting).rejects.toBe(error);
  });
});
