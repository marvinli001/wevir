import { describe, expect, it } from 'vitest';
import {
  CDN_RETRY_MS,
  CDN_SETTLE_MS,
  type CdnCheck,
  checkPlatformDir,
  compareVersions,
  type Digest,
  devVersion,
  filesToPrune,
  githubAssetName,
  githubDirListing,
  isLegacyAlias,
  manifestFile,
  platformDirOfFile,
  readManifest,
  stableVersionOfTag,
  uploadInstallers,
  versionOfFile,
  waitForCdn,
} from './release.js';

describe('compareVersions', () => {
  it('按 semver 比较，预发布低于正式版，预发布号按数字比', () => {
    expect(compareVersions('0.1.0', '0.0.9')).toBe(1);
    expect(compareVersions('0.1.1-beta.1', '0.1.0')).toBe(1);
    expect(compareVersions('0.1.1-beta.9', '0.1.1')).toBe(-1);
    expect(compareVersions('0.1.1-beta.10', '0.1.1-beta.9')).toBe(1);
    expect(compareVersions('0.1.1-beta.3', '0.1.1-beta.3')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(() => compareVersions('v1.0.0', '1.0.0')).toThrow();
  });
});

describe('版本号', () => {
  it('正式版只认 vX.Y.Z 的 tag', () => {
    expect(stableVersionOfTag('v0.1.0')).toBe('0.1.0');
    expect(stableVersionOfTag('v0.1.0-rc.1')).toBeUndefined();
    expect(stableVersionOfTag('0.1.0')).toBeUndefined();
  });

  it('开发版是上一个正式版的下一个补丁号的预发布', () => {
    expect(devVersion('0.0.0', 612)).toBe('0.0.1-beta.612');
    expect(devVersion('0.1.0', 1)).toBe('0.1.1-beta.1');
    // 正式版发布后，开发版用户收到的下一个开发版高于它，正式版又高于之前所有开发版。
    expect(compareVersions(devVersion('0.1.0', 1), '0.1.0')).toBe(1);
    expect(compareVersions('0.1.0', devVersion('0.0.0', 999))).toBe(1);
  });
});

const MAC_MANIFEST = `version: 0.1.1-beta.4
files:
  - url: Wevir-0.1.1-beta.4-mac-arm64.zip
    sha512: abc
    size: 1
  - url: Wevir-0.1.1-beta.4-mac-arm64.dmg
    sha512: def
    size: 2
path: Wevir-0.1.1-beta.4-mac-arm64.zip
sha512: abc
releaseDate: '2026-10-16T00:00:00.000Z'
`;

describe('清单', () => {
  it('文件名与 feed.ts 一致', () => {
    expect(manifestFile('beta', 'darwin-arm64')).toBe('beta-mac.yml');
    expect(manifestFile('latest', 'win32-x64')).toBe('latest.yml');
  });

  it('读出版本与列出的文件', () => {
    expect(readManifest(MAC_MANIFEST)).toEqual({
      version: '0.1.1-beta.4',
      files: ['Wevir-0.1.1-beta.4-mac-arm64.zip', 'Wevir-0.1.1-beta.4-mac-arm64.dmg'],
    });
    expect(readManifest("version: '0.1.0'\nfiles: []\n").version).toBe('0.1.0');
    expect(() => readManifest('files: []\n')).toThrow();
  });

  it('平台目录要有本通道本版本的清单、签名与清单列出的文件', () => {
    const names = [
      'beta-mac.yml',
      'beta-mac.yml.sig',
      'Wevir-0.1.1-beta.4-mac-arm64.zip',
      'Wevir-0.1.1-beta.4-mac-arm64.zip.blockmap',
      'Wevir-0.1.1-beta.4-mac-arm64.dmg',
      'Wevir-0.1.1-beta.4-mac-arm64.dmg.blockmap',
    ];
    const release = checkPlatformDir('darwin-arm64', names, MAC_MANIFEST, 'dev', '0.1.1-beta.4');
    expect(release.manifest).toBe('beta-mac.yml');
    expect(release.payload).toEqual(names.slice(2));
    expect(() =>
      checkPlatformDir('darwin-arm64', names, MAC_MANIFEST, 'stable', '0.1.1-beta.4'),
    ).toThrow(/latest-mac.yml is missing/);
    expect(() =>
      checkPlatformDir('darwin-arm64', names, MAC_MANIFEST, 'dev', '0.1.1-beta.5'),
    ).toThrow(/expected 0.1.1-beta.5/);
    expect(() =>
      checkPlatformDir('darwin-arm64', names.slice(0, 3), MAC_MANIFEST, 'dev', '0.1.1-beta.4'),
    ).toThrow(/dmg listed/);
    expect(() =>
      checkPlatformDir(
        'darwin-arm64',
        names.filter((n) => !n.endsWith('.sig')),
        MAC_MANIFEST,
        'dev',
        '0.1.1-beta.4',
      ),
    ).toThrow(/sig is missing/);
  });
});

describe('清理', () => {
  it('安装包文件名里的版本', () => {
    expect(versionOfFile('Wevir-0.1.1-beta.4-mac-arm64.zip.blockmap')).toBe('0.1.1-beta.4');
    expect(versionOfFile('Wevir-0.1.0-win-x64-setup.exe')).toBe('0.1.0');
    expect(versionOfFile('beta-mac.yml')).toBeUndefined();
  });

  it('认出以前的固定名字安装包', () => {
    expect(isLegacyAlias('Wevir-beta-mac-arm64.dmg')).toBe(true);
    expect(isLegacyAlias('Wevir-latest-win-x64-setup.exe')).toBe(true);
    expect(isLegacyAlias('Wevir-0.1.1-beta.4-mac-arm64.dmg')).toBe(false);
    expect(isLegacyAlias('beta-mac.yml')).toBe(false);
    expect(versionOfFile('Wevir-beta-mac-arm64.dmg')).toBeUndefined();
  });

  it('只删没被引用、也不在最新几个里的版本', () => {
    const versions = [
      '0.1.0',
      '0.1.1-beta.1',
      '0.1.1-beta.2',
      '0.1.1-beta.3',
      '0.1.1-beta.10',
      '0.0.1-beta.600',
    ];
    const names = [
      'latest-mac.yml',
      'beta-mac.yml.sig',
      ...versions.flatMap((v) => [`Wevir-${v}-mac-arm64.zip`, `Wevir-${v}-mac-arm64.zip.blockmap`]),
    ];
    expect(filesToPrune(names, new Set(['0.1.0', '0.1.1-beta.10']), 2)).toEqual([
      'Wevir-0.1.1-beta.1-mac-arm64.zip',
      'Wevir-0.1.1-beta.1-mac-arm64.zip.blockmap',
      'Wevir-0.1.1-beta.2-mac-arm64.zip',
      'Wevir-0.1.1-beta.2-mac-arm64.zip.blockmap',
      'Wevir-0.0.1-beta.600-mac-arm64.zip',
      'Wevir-0.0.1-beta.600-mac-arm64.zip.blockmap',
    ]);
  });

  it('正式版也只留最新几个，以前的固定名字安装包删掉', () => {
    const versions = ['0.1.0', '0.2.0', '0.3.0', '0.3.1-beta.4', '0.3.1-beta.7', '0.3.1-beta.9'];
    const names = [
      'latest-mac.yml',
      'Wevir-latest-mac-arm64.dmg',
      'Wevir-beta-mac-arm64.dmg',
      ...versions.map((v) => `Wevir-${v}-mac-arm64.dmg`),
    ];
    expect(filesToPrune(names, new Set(['0.3.0', '0.3.1-beta.9']), 2)).toEqual([
      'Wevir-latest-mac-arm64.dmg',
      'Wevir-beta-mac-arm64.dmg',
      'Wevir-0.1.0-mac-arm64.dmg',
      'Wevir-0.3.1-beta.4-mac-arm64.dmg',
    ]);
  });
});

describe('waitForCdn', () => {
  const good: Digest = { size: 10, sha512: 'good' };

  /** 每个地址按顺序给出这些结果（Error 表示请求失败），时间只随 sleep 前进。 */
  function fakeCdn(answers: Record<string, (Digest | Error)[]>) {
    let clock = 0;
    const purged: string[] = [];
    const lines: string[] = [];
    const check: CdnCheck = {
      async fetchDigest(url) {
        const next = answers[url]?.shift();
        if (next === undefined) throw new Error(`unexpected fetch ${url}`);
        if (next instanceof Error) throw next;
        return next;
      },
      async purge(url) {
        purged.push(url);
      },
      async sleep(ms) {
        clock += ms;
      },
      now: () => clock,
      log: (line) => lines.push(line),
    };
    return { check, purged, lines, elapsed: () => clock };
  }

  it('内容一致就通过，每次取之前都清缓存', async () => {
    const cdn = fakeCdn({ a: [good], b: [good] });
    await waitForCdn(
      [
        { url: 'a', expected: good },
        { url: 'b', expected: good },
      ],
      cdn.check,
    );
    expect(cdn.purged).toEqual(['a', 'b']);
    expect(cdn.elapsed()).toBe(0);
  });

  it('半截、内容不同或请求失败时清缓存重取，直到一致', async () => {
    const cdn = fakeCdn({
      a: [{ size: 7, sha512: 'x' }, { size: 10, sha512: 'old' }, new Error('HTTP 404'), good],
    });
    await waitForCdn([{ url: 'a', expected: good }], cdn.check);
    expect(cdn.purged).toEqual(['a', 'a', 'a', 'a']);
    expect(cdn.elapsed()).toBe(3 * CDN_RETRY_MS);
    expect(cdn.lines.join('\n')).toContain('7 bytes, expected 10');
    expect(cdn.lines.join('\n')).toContain('content differs');
    expect(cdn.lines.at(-1)).toBe('[global] verified a (attempt 4)');
  });

  it('超时还对不上就抛错', async () => {
    const cdn = fakeCdn({ a: Array.from({ length: 10 }, () => ({ size: 10, sha512: 'old' })) });
    await expect(
      waitForCdn([{ url: 'a', expected: good }], cdn.check, 2 * CDN_RETRY_MS),
    ).rejects.toThrow(/a still does not match the upload .*content differs/);
  });
});

describe('uploadInstallers', () => {
  const lines = [{ id: 'global' }, { id: 'second' }, { id: 'github' }];

  function record(failVerify = false) {
    const events: string[] = [];
    let wake: () => void = () => {};
    const steps = {
      upload: (line: { id: string }) => events.push(`upload ${line.id}`),
      global: {
        async verify() {
          events.push('verify');
          if (failVerify) throw new Error('CDN mismatch');
        },
        async purge() {
          events.push('purge');
        },
      },
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          events.push(`sleep ${ms}`);
          wake = () => {
            events.push('woke');
            resolve();
          };
        }),
      log: () => {},
    };
    return { events, steps, wake: () => wake() };
  }

  it('全球线路先传、核对，等副本的那段时间里传其余线路，等满再清缓存', async () => {
    const { events, steps, wake } = record();
    const done = uploadInstallers(lines, steps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 其余线路已经传完，仍在等。
    expect(events).toEqual([
      'upload global',
      'verify',
      `sleep ${CDN_SETTLE_MS}`,
      'upload second',
      'upload github',
    ]);
    wake();
    await done;
    expect(events.slice(-2)).toEqual(['woke', 'purge']);
  });

  it('全球线路核对失败时不传其余线路', async () => {
    const { events, steps } = record(true);
    await expect(uploadInstallers(lines, steps)).rejects.toThrow('CDN mismatch');
    expect(events).toEqual(['upload global', 'verify']);
  });

  it('不核对全球线路（没有 Bunny 密钥）或没有全球线路时依次上传、不等', async () => {
    const { events, steps } = record();
    await uploadInstallers(lines, { ...steps, global: undefined });
    expect(events).toEqual(['upload global', 'upload second', 'upload github']);
    const second = record();
    await uploadInstallers([{ id: 'second' }], second.steps);
    expect(second.events).toEqual(['upload second']);
  });
});

describe('GitHub 线路的附件名', () => {
  it('安装包与 blockmap 的名字里认出平台目录', () => {
    expect(platformDirOfFile('Wevir-0.1.0-mac-arm64.zip')).toBe('darwin-arm64');
    expect(platformDirOfFile('Wevir-0.1.1-beta.3-mac-x64.dmg.blockmap')).toBe('darwin-x64');
    expect(platformDirOfFile('Wevir-0.1.1-beta.3-win-x64-setup.exe')).toBe('win32-x64');
    expect(platformDirOfFile('beta-mac.yml')).toBeUndefined();
  });

  it('清单与签名加平台前缀，安装包照原名；放错目录的安装包不收', () => {
    expect(githubAssetName('darwin-arm64', 'latest-mac.yml')).toBe('darwin-arm64-latest-mac.yml');
    expect(githubAssetName('win32-x64', 'beta.yml.sig')).toBe('win32-x64-beta.yml.sig');
    expect(githubAssetName('darwin-arm64', 'Wevir-0.1.0-mac-arm64.zip')).toBe(
      'Wevir-0.1.0-mac-arm64.zip',
    );
    expect(() => githubAssetName('darwin-x64', 'Wevir-0.1.0-mac-arm64.zip')).toThrow();
  });

  it('按平台目录列出附件，给清理用', () => {
    const assets = [
      'darwin-arm64-latest-mac.yml',
      'darwin-arm64-latest-mac.yml.sig',
      'darwin-x64-latest-mac.yml',
      'win32-x64-beta.yml',
      'Wevir-0.1.0-mac-arm64.zip',
      'Wevir-0.1.0-mac-arm64.zip.blockmap',
      'Wevir-0.1.0-mac-x64.zip',
      'Wevir-0.1.1-beta.2-win-x64-setup.exe',
    ];
    expect(githubDirListing(assets, 'darwin-arm64')).toEqual([
      'latest-mac.yml',
      'latest-mac.yml.sig',
      'Wevir-0.1.0-mac-arm64.zip',
      'Wevir-0.1.0-mac-arm64.zip.blockmap',
    ]);
    expect(githubDirListing(assets, 'win32-x64')).toEqual([
      'beta.yml',
      'Wevir-0.1.1-beta.2-win-x64-setup.exe',
    ]);
  });
});
