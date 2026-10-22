import type { SqliteDatabase } from './driver.js';
import { text } from './rows.js';

/** 以 `failed` 结束、之后同一会话没有再开始回合的一个回合（收件箱重建用）。 */
export interface FailedTurnRecord {
  sessionId: string;
  turnId: string;
  /** `turn.finished` 的时刻。 */
  finishedAt: string;
}

/** 收件箱（0022_inbox_dismissals，协议 0.105.0）：收起记录，以及 Host 启动重建收件箱时从事件里查的两样。 */
export interface InboxRepository {
  /** 收起过的项的 ID。 */
  dismissed(): Set<string>;
  /** 记下收起；已经收起过时不变。 */
  dismiss(itemId: string, dismissedAt: string): void;
  /** 只留 `keep` 里的收起记录，其余删掉；返回删掉的条数。 */
  retainDismissals(keep: ReadonlySet<string>): number;
  /** 每个会话里没被新回合盖住的失败回合，`turn.finished` 不早于 `since`。 */
  failedTurns(options: { since: string }): FailedTurnRecord[];
  /** 有还没结束的提问（`question.requested` 之后没有对应的 `question.resolved`）的会话。 */
  sessionsWithPendingQuestions(): string[];
}

export function createInboxRepository(db: SqliteDatabase): InboxRepository {
  const listDismissed = db.prepare('SELECT item_id FROM inbox_dismissals');
  const insert = db.prepare(
    'INSERT INTO inbox_dismissals (item_id, dismissed_at) VALUES (?, ?) ON CONFLICT (item_id) DO NOTHING',
  );
  const remove = db.prepare('DELETE FROM inbox_dismissals WHERE item_id = ?');
  const failedTurns = db.prepare(`
    SELECT finished.session_id, json_extract(finished.payload, '$.turnId') AS turn_id, finished.ts
    FROM events AS finished
    WHERE finished.type = 'turn.finished'
      AND json_extract(finished.payload, '$.outcome') = 'failed'
      AND finished.ts >= :since
      AND NOT EXISTS (
        SELECT 1 FROM events AS later
        WHERE later.session_id = finished.session_id AND later.seq > finished.seq AND later.type = 'turn.started'
      )
    ORDER BY finished.ts, finished.session_id`);
  const pendingQuestions = db.prepare(`
    SELECT DISTINCT asked.session_id
    FROM events AS asked
    WHERE asked.type = 'question.requested'
      AND NOT EXISTS (
        SELECT 1 FROM events AS resolved
        WHERE resolved.session_id = asked.session_id AND resolved.seq > asked.seq
          AND resolved.type = 'question.resolved'
          AND json_extract(resolved.payload, '$.questionId') = json_extract(asked.payload, '$.question.id')
      )
    ORDER BY asked.session_id`);

  const dismissed = () => new Set(listDismissed.all().map((row) => text(row, 'item_id')));
  return {
    dismissed,
    dismiss(itemId, dismissedAt) {
      insert.run(itemId, dismissedAt);
    },
    retainDismissals(keep) {
      let removed = 0;
      for (const itemId of dismissed()) {
        if (keep.has(itemId)) continue;
        remove.run(itemId);
        removed += 1;
      }
      return removed;
    },
    failedTurns: ({ since }) =>
      failedTurns.all({ since }).map((row) => ({
        sessionId: text(row, 'session_id'),
        turnId: text(row, 'turn_id'),
        finishedAt: text(row, 'ts'),
      })),
    sessionsWithPendingQuestions: () =>
      pendingQuestions.all().map((row) => text(row, 'session_id')),
  };
}
