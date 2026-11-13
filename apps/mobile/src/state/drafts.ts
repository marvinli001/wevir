import type { ComputerCache } from '../lib/cache';
import { openComputerCache } from '../lib/cache-store';

const drafts = new Map<string, SavedDraft>();
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
  if (drafts.has(key)) return drafts.get(key) as SavedDraft;
  const value = await persistent.readState(key);
  if (!drafts.has(key)) drafts.set(key, value);
  return readDraftState(key);
}
export function writeDraft(key: string, text: string, uncertain = false): Promise<void> {
  const value = { text, uncertain };
  drafts.set(key, value);
  return persistent.writeState(key, value);
}
export async function settleDraft(key: string, sentText?: string): Promise<void> {
  const value = await persistent.settle(key, sentText);
  const current = drafts.get(key);
  drafts.set(key, current && current.text !== sentText ? { ...current, uncertain: false } : value);
}
export async function forgetDrafts(scope: string): Promise<void> {
  for (const key of drafts.keys()) if (key.startsWith(`${scope}/`)) drafts.delete(key);
  await persistent.drain();
  await (await db()).forgetDrafts(scope);
}

import { PersistentDrafts, type SavedDraft } from '@wevir/client-sdk';
