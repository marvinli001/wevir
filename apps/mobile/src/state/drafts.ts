import type { ComputerCache } from '../lib/cache';
import { openComputerCache } from '../lib/cache-store';

const drafts = new Map<string, string>();
let database: Promise<ComputerCache> | undefined;
let writes: Promise<void> = Promise.resolve();
const db = () => (database ??= openComputerCache('drafts'));

export function readDraft(key: string): string {
  return drafts.get(key) ?? '';
}

export async function loadDraft(key: string): Promise<string> {
  if (drafts.has(key)) return drafts.get(key) as string;
  const value = await (await db()).loadDraft(key);
  if (!drafts.has(key)) drafts.set(key, value);
  return readDraft(key);
}
export function writeDraft(key: string, text: string): Promise<void> {
  if (text === '') drafts.delete(key);
  else drafts.set(key, text);
  const write = writes.then(async () => (await db()).saveDraft(key, text));
  writes = write.catch(() => {});
  return write;
}
export async function forgetDrafts(scope: string): Promise<void> {
  for (const key of drafts.keys()) if (key.startsWith(`${scope}/`)) drafts.delete(key);
  await writes;
  await (await db()).forgetDrafts(scope);
}
