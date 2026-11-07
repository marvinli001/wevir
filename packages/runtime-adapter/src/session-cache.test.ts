import { expect, it } from 'vitest';
import { EventHub } from './event-hub.js';
import { trimSessionCache } from './session-cache.js';

it('bounds closed records while preserving unread child streams', async () => {
  const sessions = new Map<string, EventHub<string>>();
  const child = new EventHub<string>({ bufferUntilSubscribed: true });
  child.emit('early');
  child.end();
  sessions.set('child', child);
  for (let i = 0; i < 40; i += 1) {
    const hub = new EventHub<string>();
    hub.end();
    sessions.set(String(i), hub);
  }
  trimSessionCache(sessions, (hub) => hub.ended && !hub.awaitingFirstSubscriber);
  expect(sessions.size).toBe(32);
  expect(sessions.has('0')).toBe(false);
  expect(sessions.has('child')).toBe(true);
  const stream = child.subscribe();
  expect(await stream.next()).toEqual({ value: 'early', done: false });
  expect((await stream.next()).done).toBe(true);
});
