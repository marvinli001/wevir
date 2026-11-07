import { measureStorage } from './storage.js';
import type { StorageScanResult } from './storage-reader.js';

const parent = process.parentPort;
if (!parent) throw new Error('Storage scan requires a utility process');

parent.on('message', async ({ data: home }: { data: string }) => {
  let result: StorageScanResult;
  try {
    result = { ok: true, usage: await measureStorage(home) };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  parent.postMessage(result);
});
