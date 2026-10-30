// Android 发行包的版本与签名（app.config.ts 的 androidVersionCode、plugins/with-android-signing.js）：versionCode 随桌面端的版本线
// 单调递增；release 构建在设了密钥库时改用 release 签名，没设时仍是 debug。

import { describe, expect, it } from 'vitest';
import appConfig, { androidVersionCode } from '../../app.config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySigning } = require('../../plugins/with-android-signing.js') as {
  applySigning: (gradle: string) => string;
};

type ConfigInput = Parameters<typeof appConfig>[0];

describe('androidVersionCode', () => {
  it('按版本线递增：开发版在它之前的正式版之后、下一个正式版之前', () => {
    const order = [
      '0.0.1-beta.1',
      '0.0.1-beta.540',
      '0.0.1',
      '0.0.2-beta.3',
      '0.1.0-beta.2',
      '0.1.0',
      '1.0.0',
    ];
    const codes = order.map(androidVersionCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
    expect(androidVersionCode('0.0.1-beta.540')).toBe(10540);
    expect(androidVersionCode('0.0.1')).toBe(19999);
  });

  it('不认的版本与溢出的段报错', () => {
    for (const bad of ['0.1', '0.1.0-rc.1', '0.100.0', '0.0.100', '0.0.1-beta.9999', '22.0.0']) {
      expect(() => androidVersionCode(bad), bad).toThrow();
    }
  });

  it('设了 WEVIR_ANDROID_VERSION 才改 Android 的版本，iOS 的不变', () => {
    const saved = process.env.WEVIR_ANDROID_VERSION;
    try {
      process.env.WEVIR_ANDROID_VERSION = '0.0.2-beta.7';
      const result = appConfig({ config: {}, projectRoot: __dirname } as unknown as ConfigInput);
      expect(result.android).toMatchObject({ version: '0.0.2-beta.7', versionCode: 20007 });
      expect(result.version).toBe('1.0.0');
      delete process.env.WEVIR_ANDROID_VERSION;
      const dev = appConfig({ config: {}, projectRoot: __dirname } as unknown as ConfigInput);
      expect(dev.android?.version).toBeUndefined();
      expect(dev.android?.versionCode).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.WEVIR_ANDROID_VERSION;
      else process.env.WEVIR_ANDROID_VERSION = saved;
    }
  });
});

describe('with-android-signing', () => {
  // Expo prebuild 生成的 android/app/build.gradle 的相关部分。
  const GRADLE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

  it('加 release 签名配置，release 构建类型按环境变量选择，debug 不动', () => {
    const out = applySigning(GRADLE);
    expect(out).toContain("def keystore = System.getenv('WEVIR_ANDROID_KEYSTORE')");
    expect(out).toContain(
      "signingConfig System.getenv('WEVIR_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug",
    );
    const debug = /debug \{\s*signingConfig signingConfigs\.debug\s*\}/;
    expect(out).toMatch(debug);
    expect(applySigning(out)).toBe(out);
  });

  it('生成的文件形状变了就报错，不静默发出 debug 签名的包', () => {
    expect(() => applySigning('android {}')).toThrow();
    expect(() =>
      applySigning('android { signingConfigs { debug {} } buildTypes { release {} } }'),
    ).toThrow();
  });
});
