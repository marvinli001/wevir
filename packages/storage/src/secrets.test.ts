import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretStore, SECRETS_FILE } from './secrets.js';
import { useTempDir } from './test-utils.js';

// 测试用的假密钥，不是真实 Key。
const FAKE_KEY = 'sk-test-0000000000000000';

describe('FileSecretStore', () => {
  const dataDir = useTempDir();

  it('set / get / delete', async () => {
    const store = new FileSecretStore(dataDir());
    expect(await store.get('provider:a')).toBeUndefined();
    await store.set('provider:a', FAKE_KEY);
    await store.set('provider:b', 'other');
    expect(await store.get('provider:a')).toBe(FAKE_KEY);
    expect(await new FileSecretStore(dataDir()).get('provider:b')).toBe('other');

    expect(await store.delete('provider:a')).toBe(true);
    expect(await store.delete('provider:a')).toBe(false);
    expect(await store.get('provider:a')).toBeUndefined();
    expect(await store.get('provider:b')).toBe('other');
  });

  it('文件位于数据目录下的 secrets.json', async () => {
    const store = new FileSecretStore(dataDir());
    await store.set('provider:a', FAKE_KEY);
    expect(store.path).toBe(join(dataDir(), SECRETS_FILE));
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({
      version: 1,
      secrets: { 'provider:a': FAKE_KEY },
    });
  });

  // Windows 上 chmod 只能改只读位，0600 不生效；那里依赖 %APPDATA% 目录的按用户 ACL（ADR-0003）。
  it.skipIf(process.platform === 'win32')('secrets.json 的权限是 0600', async () => {
    const store = new FileSecretStore(dataDir());
    await store.set('provider:a', FAKE_KEY);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('已有的宽权限文件在下一次写入后变为 0600', async () => {
    const path = join(dataDir(), SECRETS_FILE);
    writeFileSync(path, JSON.stringify({ version: 1, secrets: {} }), { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    await new FileSecretStore(dataDir()).set('provider:a', FAKE_KEY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('写入后不留临时文件；并发写入不丢数据', async () => {
    const store = new FileSecretStore(dataDir());
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.set(`provider:${i}`, `${FAKE_KEY}-${i}`)),
    );
    for (let i = 0; i < 10; i++) expect(await store.get(`provider:${i}`)).toBe(`${FAKE_KEY}-${i}`);
    expect(readdirSync(dataDir())).toEqual([SECRETS_FILE]);
  });

  it('数据目录不存在时自动创建', async () => {
    const store = new FileSecretStore(join(dataDir(), 'nested', 'dir'));
    await store.set('provider:a', FAKE_KEY);
    expect(await store.get('provider:a')).toBe(FAKE_KEY);
  });

  it('文件损坏时报错，错误信息不含文件内容，也不覆盖文件', async () => {
    const path = join(dataDir(), SECRETS_FILE);
    const corrupt = `{"version":1,"secrets":{"provider:a":"${FAKE_KEY}"`;
    writeFileSync(path, corrupt);
    const store = new FileSecretStore(dataDir());
    const error = await store.get('provider:a').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(FAKE_KEY);
    expect((error as Error).cause).toBeUndefined();
    await expect(store.set('provider:b', 'x')).rejects.toThrow(/不是合法的 JSON/);
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it('格式无法识别时报错', async () => {
    writeFileSync(join(dataDir(), SECRETS_FILE), JSON.stringify({ version: 2, secrets: {} }));
    await expect(new FileSecretStore(dataDir()).get('x')).rejects.toThrow(/格式无法识别/);
  });

  it('不会把原型链上的属性当成密钥', async () => {
    const store = new FileSecretStore(dataDir());
    await store.set('provider:a', FAKE_KEY);
    expect(await store.get('toString')).toBeUndefined();
    expect(await store.get('__proto__')).toBeUndefined();
  });

  it('secretRef 必须是非空字符串', () => {
    const store = new FileSecretStore(dataDir());
    expect(() => store.get('')).toThrow(TypeError);
  });
});
