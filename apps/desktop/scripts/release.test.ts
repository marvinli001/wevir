import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEECH_MIRRORS, SPEECH_RELEASE_TAG } from '../../../packages/host/src/speech/install.ts';
import {
  CDN_RETRY_MS,
  CDN_SETTLE_MS,
  type CdnCheck,
  CLI_GITHUB_TAG,
  CLI_ROOT,
  cacheControlOf,
  checkPlatformDir,
  checksumsText,
  cliChannelFile,
  cliChecksumsFile,
  cliPackages,
  compareVersions,
  type Digest,
  devBuildNumber,
  devVersion,
  filesToPrune,
  forEachLimit,
  githubAssetName,
  githubDirListing,
  isLegacyAlias,
  LINE_IDS,
  MIRRORS,
  manifestFile,
  platformDirOfFile,
  readManifest,
  stableVersionOfTag,
  uploadInstallers,
  uploadTimeoutMs,
  versionOfCliFile,
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

  it('开发版的 N 不低于线路上已发布的同一预发布的号 + 1', () => {
    expect(devBuildNumber('0.0.0', 358, ['0.0.1-beta.364', '0.0.1-beta.362'])).toBe(365);
    expect(devBuildNumber('0.0.0', 370, ['0.0.1-beta.364'])).toBe(370);
    expect(devBuildNumber('0.0.0', 5, [])).toBe(5);
    // 别的预发布（正式版之后重新计数）不算。
    expect(devBuildNumber('0.1.0', 3, ['0.0.1-beta.364', '0.1.0'])).toBe(3);
    expect(devBuildNumber('0.0.0', 3, ['0.0.10-beta.900'])).toBe(3);
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
      upload: async (line: { id: string }) => {
        events.push(`upload ${line.id}`);
      },
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

  it('不核对全球线路（没有 Bunny 密钥）或没有全球线路时一起上传、不等', async () => {
    const { events, steps } = record();
    await uploadInstallers(lines, { ...steps, global: undefined });
    expect(events).toEqual(['upload global', 'upload second', 'upload github']);
    const second = record();
    await uploadInstallers([{ id: 'second' }], second.steps);
    expect(second.events).toEqual(['upload second']);
  });
});

describe('上传', () => {
  it('单次尝试按最低 2 MiB/s 限时，再加 1 分钟', () => {
    expect(uploadTimeoutMs(0)).toBe(60_000);
    // 2026-10-22 最大的安装包约 257 MB：正常 15–30 秒传完，挂住时约 3 分钟就重传，不再等 15 分钟。
    expect(uploadTimeoutMs(256_873_842)).toBe(60_000 + 123_000);
  });

  it('同时最多跑 limit 个，全部跑完', async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 8 - n));
      done.push(n);
      running--;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('有一个失败就不再开始新的，等在跑的跑完再抛出', async () => {
    const started: number[] = [];
    let finished = 0;
    await expect(
      forEachLimit([1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        if (n === 1) throw new Error('stuck');
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished++;
      }),
    ).rejects.toThrow('stuck');
    expect(started).toEqual([1, 2]);
    expect(finished).toBe(1);
  });
});

describe('线路', () => {
  it('传 R2、Bunny 与 GitHub；R2 带 Cache-Control，清单不缓存、安装包长期缓存', () => {
    expect(LINE_IDS).toEqual(['r2', 'global', 'github']);
    expect(MIRRORS.map((m) => [m.publicUrl, m.env, m.cacheControl === true])).toEqual([
      ['https://dl.edgeweir.com', 'WEVIR_R2', true],
      ['https://download.wevir.si', 'WEVIR_GLOBAL', false],
    ]);
    expect(cacheControlOf('beta-mac.yml')).toBe('no-cache');
    expect(cacheControlOf('beta-mac.yml.sig')).toBe('no-cache');
    expect(cacheControlOf('Wevir-0.1.1-beta.3-mac-arm64.zip')).toBe(
      'public, max-age=31536000, immutable',
    );
  });
  it('听写模型的线路与 Host 下载用的地址一致（S3 线路的 speech/ 下与 GitHub 的 speech-models）', () => {
    expect(SPEECH_MIRRORS.map((m) => [m.id, m.url])).toEqual([
      ['github', `https://github.com/marvinli001/wevir/releases/download/${SPEECH_RELEASE_TAG}`],
      ...MIRRORS.map((m) => [m.id, `${m.publicUrl}/speech`]),
    ]);
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

describe('命令行包', () => {
  it('认出命令行包与校验和文件的版本', () => {
    expect(versionOfCliFile('wevir-cli-0.2.1-beta.4-linux-x64.tar.gz')).toBe('0.2.1-beta.4');
    expect(versionOfCliFile('wevir-cli-0.2.0-win32-x64.zip')).toBe('0.2.0');
    expect(versionOfCliFile('wevir-cli-0.2.0-checksums.txt')).toBe('0.2.0');
    expect(versionOfCliFile(cliChecksumsFile('1.0.0-beta.1'))).toBe('1.0.0-beta.1');
    for (const name of [
      'beta.txt',
      'install.sh',
      'Wevir-0.2.0-mac-arm64.zip',
      'wevir-cli-x.tar.gz',
    ]) {
      expect(versionOfCliFile(name)).toBeUndefined();
    }
  });

  it('只收同一个版本的包，校验和按 sha256sum 的格式写', () => {
    const names = [
      'wevir-cli-0.2.0-linux-x64.tar.gz',
      'wevir-cli-0.2.0-darwin-arm64.tar.gz',
      'wevir-cli-0.2.0-win32-x64.zip',
      'wevir-cli-0.2.0-checksums.txt',
      'install.sh',
    ];
    expect(cliPackages(names, '0.2.0')).toEqual([
      'wevir-cli-0.2.0-darwin-arm64.tar.gz',
      'wevir-cli-0.2.0-linux-x64.tar.gz',
      'wevir-cli-0.2.0-win32-x64.zip',
    ]);
    expect(() => cliPackages(names, '0.2.1')).toThrow(/not version 0\.2\.1/);
    expect(() => cliPackages(['install.sh'], '0.2.0')).toThrow(/no command-line packages/);
    expect(
      checksumsText([
        { name: 'b.tar.gz', sha256: 'bb' },
        { name: 'a.zip', sha256: 'aa' },
      ]),
    ).toBe('aa  a.zip\nbb  b.tar.gz\n');
  });

  it('通道文件与安装脚本不缓存，带版本的文件长期缓存；清理按通道各留几个版本', () => {
    expect(cliChannelFile('stable')).toBe('latest.txt');
    expect(cliChannelFile('dev')).toBe('beta.txt');
    for (const name of ['latest.txt', 'beta.txt', 'install.sh', 'install.ps1']) {
      expect(cacheControlOf(name)).toBe('no-cache');
    }
    expect(cacheControlOf('wevir-cli-0.2.0-checksums.txt')).toBe(
      'public, max-age=31536000, immutable',
    );
    const names = [
      '0.1.1-beta.1',
      '0.1.1-beta.2',
      '0.1.1-beta.3',
      '0.1.0',
      '0.0.9',
      '0.0.8',
    ].flatMap((version) => [`wevir-cli-${version}-linux-x64.tar.gz`, cliChecksumsFile(version)]);
    expect(
      filesToPrune(
        [...names, 'beta.txt', 'install.sh'],
        new Set(['0.1.1-beta.1']),
        2,
        versionOfCliFile,
      ),
    ).toEqual(['wevir-cli-0.0.8-linux-x64.tar.gz', cliChecksumsFile('0.0.8')]);
  });

  it('安装脚本读的线路与发布的线路一致', () => {
    const lines = [
      ...MIRRORS.filter((m) => m.id === 'r2').map((m) => `${m.publicUrl}/${CLI_ROOT}`),
      `https://github.com/marvinli001/wevir/releases/download/${CLI_GITHUB_TAG}`,
      ...MIRRORS.filter((m) => m.id === 'global').map((m) => `${m.publicUrl}/${CLI_ROOT}`),
    ];
    const sh = readFileSync(new URL('../../cli/scripts/install.sh', import.meta.url), 'utf8');
    expect(/^LINES="([^"]+)"$/m.exec(sh)?.[1]?.split(' ')).toEqual(lines);
    const ps1 = readFileSync(new URL('../../cli/scripts/install.ps1', import.meta.url), 'utf8');
    expect([...ps1.matchAll(/^ {4}'(https:[^']+)',?$/gm)].map((m) => m[1])).toEqual(lines);
  });
});
