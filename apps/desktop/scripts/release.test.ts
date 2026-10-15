import { describe, expect, it } from 'vitest';
import {
  checkPlatformDir,
  compareVersions,
  devVersion,
  filesToPrune,
  manifestFile,
  readManifest,
  stableVersionOfTag,
  versionOfFile,
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

  it('只删没被引用、也不在最新几个里的预发布', () => {
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
});
