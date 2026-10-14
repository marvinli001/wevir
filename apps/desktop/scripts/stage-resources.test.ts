import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hostTarget } from './stage-resources.js';

describe('hostTarget', () => {
  it('与 fetch-codex.sh 的三元组一致', () => {
    const script = readFileSync(
      new URL('../../../scripts/fetch-codex.sh', import.meta.url),
      'utf8',
    );
    const cases: Array<[NodeJS.Platform, string, string]> = [
      ['darwin', 'arm64', 'aarch64-apple-darwin'],
      ['darwin', 'x64', 'x86_64-apple-darwin'],
      ['linux', 'x64', 'x86_64-unknown-linux-musl'],
      ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
      ['win32', 'x64', 'x86_64-pc-windows-msvc'],
      ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ];
    for (const [platform, arch, target] of cases) {
      expect(hostTarget(platform, arch)).toBe(target);
      expect(script).toContain(`  ${target})`);
    }
    expect(() => hostTarget('freebsd', 'x64')).toThrow('不支持');
  });
});
