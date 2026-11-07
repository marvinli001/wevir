export const SESSION_CACHE_LIMIT = 32;

/** Active sessions and unread child streams remain pinned. */
export function trimSessionCache<T>(sessions: Map<string, T>, idle: (session: T) => boolean): void {
  for (const [id, session] of sessions) {
    if (sessions.size <= SESSION_CACHE_LIMIT) break;
    if (idle(session)) sessions.delete(id);
  }
}
