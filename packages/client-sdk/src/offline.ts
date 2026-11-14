import { type Session, SessionSchema, type WevirEvent, WevirEventSchema } from '@wevir/protocol';
import { ConnectionLostError, RequestTimeoutError, WevirRpcError } from './errors.js';
import { TranscriptProjection } from './projection.js';

export function sendOutcomeUnknown(error: unknown): boolean {
  if (error instanceof WevirRpcError) return false;
  if (error instanceof ConnectionLostError || error instanceof RequestTimeoutError)
    return error.sent;
  return true;
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
  clientMessageId?: string;
  submittedText?: string;
  sessionId?: string;
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
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      await this.#save(key, {
        ...current,
        ...value,
        uncertain: current.uncertain || value.uncertain,
      });
    });
    this.#writes = next.catch(() => {});
    return next;
  }
  settle(key: string, sentText?: string, clientMessageId?: string): Promise<SavedDraft> {
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      if (clientMessageId && current.clientMessageId !== clientMessageId) return current;
      const value: SavedDraft = {
        text: current.text === sentText ? '' : current.text,
        uncertain: false,
        ...(sentText === undefined && current.sessionId && { sessionId: current.sessionId }),
      };
      await this.#save(key, value);
      return value;
    });
    this.#writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  begin(
    key: string,
    text: string,
    clientMessageId: string,
  ): Promise<SavedDraft & { clientMessageId: string }> {
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      if (current.uncertain && current.clientMessageId) {
        return { ...current, clientMessageId: current.clientMessageId };
      }
      const value = { ...current, text, uncertain: true, clientMessageId, submittedText: text };
      await this.#save(key, value);
      return value;
    });
    this.#writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  bindSession(key: string, sessionId?: string): Promise<SavedDraft> {
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      const { sessionId: _previous, ...rest } = current;
      const value = { ...rest, ...(sessionId && { sessionId }) };
      await this.#save(key, value);
      return value;
    });
    this.#writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  acknowledge(key: string, clientMessageId: string): Promise<SavedDraft> {
    const next = this.#writes.then(async () => {
      const current = await this.#read(key);
      if (current.clientMessageId !== clientMessageId) return current;
      const value = {
        text: current.text === current.submittedText ? '' : current.text,
        uncertain: false,
      };
      await this.#save(key, value);
      return value;
    });
    this.#writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  async reconcile(key: string, events: readonly WevirEvent[]): Promise<SavedDraft> {
    const current = await this.readState(key);
    const known = events.some(
      (event) =>
        event.type === 'user.message' && event.payload.clientMessageId === current.clientMessageId,
    );
    return current.clientMessageId && known
      ? this.acknowledge(key, current.clientMessageId)
      : current;
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
      for (const field of ['clientMessageId', 'submittedText', 'sessionId'] as const)
        if (state[field] !== undefined && typeof state[field] !== 'string')
          throw new Error('draft state unreadable');
      return {
        text: state.text,
        uncertain: state.uncertain,
        ...(state.clientMessageId && { clientMessageId: state.clientMessageId }),
        ...(state.submittedText !== undefined && { submittedText: state.submittedText }),
        ...(state.sessionId && { sessionId: state.sessionId }),
      };
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
