import { beforeEach, describe, expect, it } from 'vitest';
import { ORB_STATES, pickOrb, resetTurnOrbs, turnOrb } from './orb-state';

const turns = Array.from(
  { length: 300 },
  (_, i) => `trn_01JA2B3C4D5E6F7G8H9J${i.toString(36).padStart(6, '0')}`,
);

beforeEach(() => resetTurnOrbs());

describe('thinking orb 的选择', () => {
  it('同一个回合 ID 总是同一种；一批回合用到了全部 9 种', () => {
    for (const turn of turns) expect(pickOrb(turn, undefined)).toBe(pickOrb(turn, undefined));
    expect(new Set(turns.map((turn) => pickOrb(turn, undefined))).size).toBe(ORB_STATES.length);
  });

  it('不和上一回合重复', () => {
    for (const previous of ORB_STATES) {
      for (const turn of turns.slice(0, 50)) expect(pickOrb(turn, previous)).not.toBe(previous);
    }
  });

  it('按会话记下：先问到的定下来，之后重问不变，新回合避开上一回合', () => {
    const first = turnOrb('ses_a', turns[0] ?? '');
    expect(turnOrb('ses_a', turns[0] ?? '')).toBe(first);
    let previous = first;
    for (const turn of turns.slice(1, 40)) {
      const orb = turnOrb('ses_a', turn);
      expect(orb).not.toBe(previous);
      // 旧回合再被问到（消息流里的旧快照、左栏先拿到新回合）也不改。
      expect(turnOrb('ses_a', turn)).toBe(orb);
      previous = orb;
    }
  });

  it('会话之间互不影响；没记过的会话从 9 种里按回合 ID 抽', () => {
    const turn = turns[5] ?? '';
    turnOrb('ses_a', turns[4] ?? '');
    expect(turnOrb('ses_b', turn)).toBe(pickOrb(turn, undefined));
  });
});
