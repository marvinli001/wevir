import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorCredentialFile, cursorCredentialsPath, parseCredentials } from './credentials.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-cursor-creds-'));
  dirs.push(dir);
  return dir;
}

const CREDENTIALS = {
  version: 1 as const,
  backendUrl: 'https://api2.cursor.sh',
  apiKey: 'key_secret_value',
  apiKeyExpiresAtMs: 1_900_000_000_000,
  email: 'me@example.com',
  createdAtMs: 1_800_000_000_000,
};

describe('CursorCredentialFile', () => {
  it('存在数据目录的 engines/cursor/auth.json：目录 0700、文件 0600，读回原样，清除后读不到', async () => {
    const path = cursorCredentialsPath(home());
    expect(path).toMatch(/engines[/\\]cursor[/\\]auth\.json$/);
    const store = new CursorCredentialFile(path);
    expect(await store.load()).toBeUndefined();
    await store.save(CREDENTIALS);
    expect(await store.load()).toEqual(CREDENTIALS);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    }
    await store.save({ ...CREDENTIALS, apiKey: 'second' });
    expect((await store.load())?.apiKey).toBe('second');
    await store.clear();
    expect(await store.load()).toBeUndefined();
    await store.clear();
  });

  it('坏掉或别人格式的文件当作没登录，不抛错', async () => {
    const path = cursorCredentialsPath(home());
    const store = new CursorCredentialFile(path);
    await store.save(CREDENTIALS);
    writeFileSync(path, '{not json');
    expect(await store.load()).toBeUndefined();
    writeFileSync(path, JSON.stringify({ accessToken: 'cli-token' }));
    expect(await store.load()).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toContain('cli-token');
  });

  it('parseCredentials 只认 SDK 的 StoredSdkCredentials', () => {
    expect(parseCredentials(CREDENTIALS)).toEqual(CREDENTIALS);
    expect(parseCredentials({ ...CREDENTIALS, version: 2 })).toBeUndefined();
    expect(parseCredentials({ ...CREDENTIALS, apiKey: '' })).toBeUndefined();
    expect(parseCredentials({ ...CREDENTIALS, apiKeyExpiresAtMs: 'soon' })).toBeUndefined();
    const { apiKeyExpiresAtMs: _expires, email: _email, ...minimal } = CREDENTIALS;
    expect(parseCredentials(minimal)).toEqual(minimal);
  });
});
