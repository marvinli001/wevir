import { TranscriptProjection } from '@wevir/client-sdk';
import type { SessionId, TurnId, WevirEventOf } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { editRecoveryMode, type SavedEdit } from './edit-recovery';

const original = 'trn_original' as TurnId;
const latest = 'trn_latest' as TurnId;
const saved: SavedEdit = {
  sessionId: 'ses_edited' as SessionId,
  turnId: original,
  latest,
  history: true,
  content: [{ type: 'text', text: 'revised' }],
  clientMessageId: 'saved-edit-1',
};

function transcript(rows: [TurnId, string?][]) {
  const projection = new TranscriptProjection();
  rows.forEach(([turnId, clientMessageId], index) => {
    const event: WevirEventOf<'user.message'> = {
      seq: index + 1,
      sessionId: saved.sessionId,
      ts: '2026-11-17T04:05:06.000Z',
      source: 'host',
      type: 'user.message',
      payload: {
        turnId,
        content: saved.content,
        sentBy: { deviceId: 'device', clientId: 'desk', clientKind: 'desktop' },
        ...(clientMessageId && { clientMessageId }),
      },
    };
    projection.apply(event);
  });
  return { caughtUp: true, transcript: projection.snapshot() };
}

describe('编辑恢复按当前历史选取操作', () => {
  it('追平后才识别是否已撤回或收到发送回执', () => {
    const empty = transcript([]);
    expect(editRecoveryMode(saved, { ...empty, caughtUp: false }, true, 0)).toBe('waiting');
    expect(editRecoveryMode(saved, empty, true, 0)).toBe('send');
    expect(editRecoveryMode(saved, transcript([[latest, saved.clientMessageId]]), true, 0)).toBe(
      'accepted',
    );
  });
  it('只替换原来确认的历史，新增回合、引擎或中断边界之后仅能另发', () => {
    const history = transcript([[original], [latest]]);
    expect(editRecoveryMode(saved, history, true, 0)).toBe('replace');
    expect(editRecoveryMode(saved, history, false, 0)).toBe('append');
    expect(editRecoveryMode(saved, history, true, 2)).toBe('append');
    expect(
      editRecoveryMode(saved, transcript([[original], [latest], ['trn_new' as TurnId]]), true, 0),
    ).toBe('append');
  });
});
