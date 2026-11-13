import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus.js';
import { ev, SES } from './test-utils.js';

describe('projection-only event delivery', () => {
  it('delivers received history to reading subscribers without calling business listeners', () => {
    const business = vi.fn();
    const reader = vi.fn();
    const onError = vi.fn();
    const bus = new EventBus({ onError });
    bus.listenAll(business);
    bus.subscribe(SES, reader, 0);
    const event = { ...ev.created(), sessionId: SES, seq: 1, ts: '2026-11-13T00:00:00.000Z' };
    bus.publishProjection([event]);
    expect(reader).toHaveBeenCalledWith(event);
    expect(business).not.toHaveBeenCalled();
    bus.publish([{ ...event, seq: 2 }]);
    expect(business).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
