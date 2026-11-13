import { type Session, SessionSchema, type WevirEvent, WevirEventSchema } from '@wevir/protocol';
import { isRpcError } from './errors.js';
import { TranscriptProjection } from './projection.js';

export function sendOutcomeUnknown(error: unknown): boolean {
  return !(
    ['INVALID_PARAMS', 'METHOD_NOT_FOUND', 'DEVICE_FORBIDDEN', 'SESSION_NOT_FOUND'] as const
  ).some((code) => isRpcError(error, code));
}

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
export interface SavedDraft {
  text: string;
  uncertain: boolean;
}
export class PersistentDrafts {
  #writes: Promise<void> = Promise.resolve();
  constructor(readonly storage: DraftStorage) {}
  async read(key: string) {
    return (await this.readState(key)).text;
  }
  write(key: string, text: string) {
    return this.writeState(key, { text, uncertain: false });
  }
  async readState(key: string): Promise<SavedDraft> {
    await this.#writes;
    return this.#read(key);
  }
  writeState(key: string, value: SavedDraft) {
    const next = this.#writes.then(() => this.#save(key, value));
    this.#writes = next.catch(() => {});
    return next;
  }
  settle(key: string, sentText?: string): Promise<SavedDraft> {
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      const value = { text: current.text === sentText ? '' : current.text, uncertain: false };
      await this.#save(key, value);
      return value;
    });
    this.#writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  drain() {
    return this.#writes;
  }
  async #read(key: string): Promise<SavedDraft> {
    const raw = await this.storage.get(`${key}/state-v1`);
    if (raw !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error('draft state unreadable');
      }
      const state = value as (Partial<SavedDraft> & { v?: number }) | null;
      if (state?.v !== 1 || typeof state.text !== 'string' || typeof state.uncertain !== 'boolean')
        throw new Error('draft state unreadable');
      return { text: state.text, uncertain: state.uncertain };
    }
    const text = (await this.storage.get(key)) ?? '';
    // Legacy text drafts do not record whether a send reached the Host.
    return { text, uncertain: text !== '' };
  }
  async #save(key: string, value: SavedDraft) {
    await this.storage.set(`${key}/state-v1`, JSON.stringify({ v: 1, ...value }));
    await this.storage.delete(key);
  }
}
