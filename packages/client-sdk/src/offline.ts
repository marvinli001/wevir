import { type Session, SessionSchema, type WevirEvent, WevirEventSchema } from '@wevir/protocol';
import { TranscriptProjection } from './projection.js';

export interface OfflineConversation {
  hostId: string;
  clientId: string;
  session: Session;
  events: WevirEvent[];
  savedAt: string;
}
export function offlineTranscript(conversation: OfflineConversation) {
  SessionSchema.parse(conversation.session);
  if (conversation.events.length > 3000 || JSON.stringify(conversation.events).length > 2000000)
    throw new Error('offline conversation exceeds cache limits');
  const projection = new TranscriptProjection();
  for (const value of conversation.events) {
    const event = WevirEventSchema.parse(value);
    if (event.sessionId !== conversation.session.id) throw new Error('offline source mismatch');
    projection.apply(event);
  }
  return {
    ...projection.snapshot(),
    state: undefined,
    activeTurnId: undefined,
    pendingApprovals: [],
    pendingQuestions: [],
    pendingMessages: [],
  };
}

export interface DraftStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export class PersistentDrafts {
  #writes: Promise<void> = Promise.resolve();
  constructor(readonly storage: DraftStorage) {}
  async read(key: string) {
    await this.#writes;
    return (await this.storage.get(key)) ?? '';
  }
  write(key: string, text: string) {
    const next = this.#writes.then(() =>
      text === '' ? this.storage.delete(key) : this.storage.set(key, text),
    );
    this.#writes = next.catch(() => {});
    return next;
  }
}
