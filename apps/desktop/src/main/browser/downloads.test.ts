import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type DownloadItemLike,
  downloadFilename,
  trackDownload,
  uniqueSavePath,
} from './downloads.js';

class FakeItem extends EventEmitter implements DownloadItemLike {
  public received = 0;
  public cancelled = false;

  public getURL(): string {
    return 'https://a.test/report.csv';
  }

  public getMimeType(): string {
    return 'text/csv';
  }

  public getReceivedBytes(): number {
    return this.received;
  }

  public cancel(): void {
    this.cancelled = true;
    this.emit('done', {}, 'cancelled');
  }

  public progress(bytes: number): void {
    this.received = bytes;
    this.emit('updated');
  }

  public finish(state: string): void {
    this.emit('done', {}, state);
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('downloadFilename', () => {
  it('keeps only the last path segment and drops unsafe characters', () => {
    expect(downloadFilename('../../etc/passwd')).toBe('passwd');
    expect(downloadFilename('C:\\Users\\a\\report.csv')).toBe('report.csv');
    expect(downloadFilename('a:b?c*.txt')).toBe('a_b_c_.txt');
    expect(downloadFilename('..hidden')).toBe('hidden');
    expect(downloadFilename('')).toBe('download');
    expect(downloadFilename('x'.repeat(300))).toHaveLength(200);
  });
});

describe('uniqueSavePath', () => {
  it('numbers the name when the file already exists', () => {
    const taken = new Set(['/d/report.csv', '/d/report (1).csv']);
    expect(uniqueSavePath('/d', 'new.csv', (path) => taken.has(path))).toBe(join('/d', 'new.csv'));
    expect(
      uniqueSavePath('/d', 'report.csv', (path) => taken.has(path.replaceAll('\\', '/'))),
    ).toBe(join('/d', 'report (2).csv'));
  });
});

describe('trackDownload', () => {
  it('answers with the final state and size', async () => {
    const item = new FakeItem();
    const result = trackDownload(item, '/unused', 1_000);
    item.progress(10);
    item.finish('completed');
    await expect(result).resolves.toEqual({ state: 'completed', size: 10 });
  });

  it('answers in_progress when the wait ends first', async () => {
    const item = new FakeItem();
    await expect(trackDownload(item, '/unused', 10)).resolves.toEqual({
      state: 'in_progress',
      size: 0,
    });
  });

  it('cancels and deletes a download over the size cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-download-'));
    dirs.push(dir);
    const path = join(dir, 'big.bin');
    writeFileSync(path, 'partial');
    const item = new FakeItem();
    const result = trackDownload(item, path, 1_000, 100);
    item.progress(50);
    item.progress(150);
    await expect(result).resolves.toEqual({ state: 'too_large', size: 150 });
    expect(item.cancelled).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
