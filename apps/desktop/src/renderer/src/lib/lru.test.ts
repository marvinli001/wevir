import { describe, expect, it } from 'vitest';
import { LruMap } from './lru';

describe('LruMap', () => {
  it('超过项数时删最久没用的，get 算一次使用', () => {
    const map = new LruMap<string, number>(3);
    map.set('a', 1).set('b', 2).set('c', 3);
    expect(map.get('a')).toBe(1);
    map.set('d', 4);
    expect([...map.keys()]).toEqual(['c', 'a', 'd']);
    expect(map.has('b')).toBe(false);
  });

  it('按大小删到不超过上限，最新的那项总是留着', () => {
    const map = new LruMap<string, string>(10, { maxWeight: 10, weigh: (text) => text.length });
    map.set('a', 'xxxx').set('b', 'xxxx');
    map.set('c', 'xxxx');
    expect([...map.keys()]).toEqual(['b', 'c']);
    map.set('big', 'x'.repeat(50));
    expect([...map.keys()]).toEqual(['big']);
    map.set('d', 'xx');
    expect([...map.keys()]).toEqual(['d']);
  });

  it('覆盖同一个键时按新值计大小', () => {
    const map = new LruMap<string, string>(10, { maxWeight: 10, weigh: (text) => text.length });
    map.set('a', 'xxxxxxxx');
    map.set('a', 'x');
    map.set('b', 'xxxxxxxx');
    expect([...map.keys()]).toEqual(['a', 'b']);
    map.delete('a');
    map.clear();
    map.set('c', 'xxxxxxxxxx');
    expect(map.size).toBe(1);
  });
});
