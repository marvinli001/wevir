// 推送的构建配置（app.config.ts）与 iOS 通知扩展的文案：没有 google-services.json 时照样能构建、只是不开 FCM；扩展的文案十种语言
// 齐全，覆盖每一种提醒。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFICATION_KINDS } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import appConfig from '../../app.config';

const root = join(__dirname, '../..');
type ConfigInput = Parameters<typeof appConfig>[0];

function config(env: Record<string, string | undefined> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try {
    return appConfig({ config: {}, projectRoot: root } as unknown as ConfigInput);
  } finally {
    process.env = saved;
  }
}

describe('推送的构建配置', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('没有 google-services.json：不设 googleServicesFile，App 不开 FCM；iOS 默认是沙盒', () => {
    const result = config({ WEVIR_GOOGLE_SERVICES_FILE: '/nonexistent/google-services.json' });
    expect(result.android?.googleServicesFile).toBeUndefined();
    expect(result.extra?.push).toEqual({ fcm: false, apnsEnvironment: 'development' });
    const plugin = result.plugins?.find((p) => Array.isArray(p) && p[0] === 'expo-notifications');
    expect(plugin?.[1]).toMatchObject({
      mode: 'development',
      enableBackgroundRemoteNotifications: true,
    });
    expect(result.plugins).toContainEqual([
      './plugins/with-notification-service.js',
      { appGroup: 'group.si.wevir.mobile' },
    ]);
  });

  it('给了文件就打包进去；发行构建用生产环境的 APNs', () => {
    dir = mkdtempSync(join(tmpdir(), 'wevir-push-config-'));
    const file = join(dir, 'google-services.json');
    writeFileSync(file, '{}');
    const result = config({
      WEVIR_GOOGLE_SERVICES_FILE: file,
      WEVIR_APNS_ENVIRONMENT: 'production',
    });
    expect(result.android?.googleServicesFile).toBe(file);
    expect(result.extra?.push).toEqual({ fcm: true, apnsEnvironment: 'production' });
  });
});

describe('通知扩展的文案', () => {
  it('十种语言都有同一组键，覆盖每一种提醒', async () => {
    const result = config();
    const locales = Object.entries(result.locales ?? {});
    expect(locales).toHaveLength(10);
    const expected = [
      'WEVIR_PUSH_BODY',
      'WEVIR_PUSH_TITLE',
      ...NOTIFICATION_KINDS.map((kind) => `WEVIR_PUSH_KIND_${kind.toUpperCase()}`),
    ].sort();
    for (const [lang, file] of locales) {
      const json = JSON.parse(await readFile(join(root, file as string), 'utf8')) as {
        ios?: { 'Localizable.strings'?: Record<string, string> };
      };
      const strings = json.ios?.['Localizable.strings'] ?? {};
      expect(Object.keys(strings).sort(), lang).toEqual(expected);
      for (const value of Object.values(strings)) expect(value.trim(), lang).not.toBe('');
    }
  });

  it('扩展认的提醒种类与协议一致', async () => {
    const swift = await readFile(
      join(root, 'plugins/notification-service/PushCrypto.swift'),
      'utf8',
    );
    const match = swift.match(/static let kinds: Set<String> = \[([^\]]*)\]/);
    const kinds = [...(match?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(kinds.sort()).toEqual([...NOTIFICATION_KINDS].sort());
  });
});
