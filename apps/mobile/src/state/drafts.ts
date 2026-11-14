import type { ComputerCache } from '../lib/cache';
import { openComputerCache } from '../lib/cache-store';

const drafts = new Map<string, SavedDraft>();
const generations = new Map<string, number>();
const forgetting = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<(value: SavedDraft, previous?: SavedDraft) => void>>();
function changed(key: string, previous?: SavedDraft) {
  for (const listener of listeners.get(key) ?? []) listener(readDraftState(key), previous);
}
export function watchDraft(
  key: string,
  listener: (value: SavedDraft, previous?: SavedDraft) => void,
) {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}
let database: Promise<ComputerCache> | undefined;
const db = () => (database ??= openComputerCache('drafts'));
const persistent = new PersistentDrafts({
  get: async (key) => (await (await db()).loadDraft(key)) || undefined,
  set: async (key, value) => (await db()).saveDraft(key, value),
  delete: async (key) => (await db()).saveDraft(key, ''),
});

export function readDraft(key: string): string {
  return readDraftState(key).text;
}
export function readDraftState(key: string): SavedDraft {
  return drafts.get(key) ?? { text: '', uncertain: false };
}
export async function loadDraft(key: string): Promise<SavedDraft> {
  const scope = key.split('/')[0] as string;
  await forgetting.get(scope);
  const generation = generations.get(scope) ?? 0;
  if (drafts.has(key)) return drafts.get(key) as SavedDraft;
  const value = await persistent.readState(key);
  if (generation !== (generations.get(scope) ?? 0)) return { text: '', uncertain: false };
  if (!drafts.has(key)) drafts.set(key, value);
  return readDraftState(key);
}
export function writeDraft(key: string, text: string, uncertain = false): Promise<void> {
  const current = readDraftState(key);
  const value = { ...current, text, uncertain: current.uncertain || uncertain };
  drafts.set(key, value);
  return persistent.writeState(key, value);
}
export async function settleDraft(
  key: string,
  sentText?: string,
  clientMessageId?: string,
): Promise<void> {
  const value = await persistent.settle(key, sentText, clientMessageId);
  const current = drafts.get(key);
  drafts.set(key, {
    ...value,
    text: current && current.text !== sentText ? current.text : value.text,
  });
  changed(key, current);
}
export async function beginDraft(key: string, text: string, id: string) {
  const value = await persistent.begin(key, text, id);
  drafts.set(key, { ...value, text: drafts.get(key)?.text ?? value.text });
  return value;
}
export async function bindDraftSession(key: string, sessionId?: string) {
  const value = await persistent.bindSession(key, sessionId);
  drafts.set(key, value);
  return value;
}
export async function acknowledgeDraft(key: string, id: string) {
  const current = await loadDraft(key);
  if (current.clientMessageId !== id) return;
  const value = await persistent.acknowledge(key, id);
  drafts.set(key, value);
  changed(key, current);
}
export function forgetDrafts(scope: string): Promise<void> {
  const previous = forgetting.get(scope);
  if (previous) return previous;
  generations.set(scope, (generations.get(scope) ?? 0) + 1);
  for (const key of drafts.keys()) if (key.startsWith(`${scope}/`)) drafts.delete(key);
  const task = (async () => {
    await persistent.drain();
    await (await db()).forgetDrafts(scope);
  })().finally(() => forgetting.delete(scope));
  forgetting.set(scope, task);
  return task;
}

import { PersistentDrafts, type SavedDraft } from '@wevir/client-sdk';
