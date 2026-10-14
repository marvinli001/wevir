import { describe, expect, it } from 'vitest';
import { EventHub } from './event-hub.js';

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const read: T[] = [];
  for (let i = 0; i < count; i += 1) {
    const next = await iterator.next();
    if (next.done) break;
    read.push(next.value);
  }
  return read;
}

describe('EventHub', () => {
  it('默认只推订阅之后的事件', async () => {
    const hub = new EventHub<number>();
    hub.emit(1);
    const sub = hub.subscribe();
    hub.emit(2);
    hub.end();
    expect(await take(sub, 5)).toEqual([2]);
  });

  it('bufferUntilSubscribed：第一个订阅者拿到之前的事件，之后的订阅者不再拿', async () => {
    const hub = new EventHub<number>({ bufferUntilSubscribed: true });
    hub.emit(1);
    hub.emit(2);
    const first = hub.subscribe();
    const second = hub.subscribe();
    hub.emit(3);
    hub.end();
    expect(await take(first, 5)).toEqual([1, 2, 3]);
    expect(await take(second, 5)).toEqual([3]);
  });

  it('bufferUntilSubscribed：没有订阅者就结束了，存下的事件仍交给之后的第一个订阅者', async () => {
    const hub = new EventHub<number>({ bufferUntilSubscribed: true });
    hub.emit(1);
    hub.end();
    hub.emit(2);
    expect(await take(hub.subscribe(), 5)).toEqual([1]);
  });
});
