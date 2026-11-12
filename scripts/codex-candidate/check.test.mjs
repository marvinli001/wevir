import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assetDigest,
  featureDefaults,
  parseArgs,
  run,
  schemaFiles,
  validationEnv,
} from '../check-codex-candidate.mjs';

describe('Codex 候选检查', () => {
  it('取消后等待子进程退出再返回', async () => {
    const controller = new AbortController();
    const result = run(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      process.env,
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100);
    await expect(result).rejects.toThrow('cancelled by test');
  });
  it('取消也回收自成进程组且忽略 SIGTERM 的后代', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-check-cancel-'));
    const marker = join(directory, 'pid');
    const controller = new AbortController();
    const result = run(
      process.execPath,
      [
        '-e',
        `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`,
      ],
      process.cwd(),
      process.env,
      undefined,
      controller.signal,
    );
    try {
      await vi.waitFor(() => expect(Number(readFileSync(marker, 'utf8'))).toBeGreaterThan(0));
      const pid = Number(readFileSync(marker, 'utf8'));
      controller.abort(new Error('cancelled tree'));
      await expect(result).rejects.toThrow('cancelled tree');
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      controller.abort();
      await result.catch(() => {});
      rmSync(directory, { recursive: true });
    }
  }, 15_000);
  it.each(['0.167.1', 'rust-v0.167.1', 'rust-v0.168.0-alpha.12'])('接受版本 %s', (version) => {
    expect(parseArgs([version])).toEqual({
      tag: version.startsWith('rust-v') ? version : `rust-v${version}`,
      diffOnly: false,
    });
  });
  it.each([[], ['../outside'], ['rust-v0.167.1/../../outside'], ['rust-v0.167.1', '--unknown']])(
    '拒绝无效参数 %j',
    (args) => {
      expect(() => parseArgs(args)).toThrow();
    },
  );
  it('仅比较必须明确指定，不能静默省略测试', () => {
    expect(parseArgs(['0.167.1', '--diff-only']).diffOnly).toBe(true);
  });
  it('新默认值与阶段都参与对比，保留平台条件表达式', () => {
    expect(
      featureDefaults(`FeatureSpec {
      key: "new_default",
      stage: Stage::Stable,
      default_enabled: true,
    }, FeatureSpec {
      key: "windows_only",
      stage: Stage::Experimental { name: "Window", },
      default_enabled: cfg!(windows),
    }`),
    ).toEqual({
      new_default: { stage: 'Stable', default: 'true' },
      windows_only: { stage: 'Experimental', default: 'cfg!(windows)' },
    });
    expect(() => featureDefaults('registry format changed')).toThrow();
  });
  it('比较注释指向的 schema 与两层依赖，保留删除的引用', () => {
    const sources = {
      'v2/Thread.ts': 'import type { Item } from "./Item";',
      'v2/Item.ts': 'import type { Image } from "../Image";',
      'Image.ts': 'export type Image = string;',
    };
    expect(
      schemaFiles(
        '/** v2/Thread.ts / Missing.ts */',
        new Set(Object.keys(sources)),
        (name) => sources[name],
      ),
    ).toEqual({ files: ['Image.ts', 'v2/Item.ts', 'v2/Thread.ts'], missing: ['Missing.ts'] });
  });
  it('没有官方摘要时拒绝安装，不能仅凭资产名字信任下载', () => {
    const digest = 'a'.repeat(64);
    expect(assetDigest({ digest: `sha256:${digest}` })).toBe(digest);
    expect(() => assetDigest({ name: 'binary', digest: null })).toThrow();
    expect(() => assetDigest({ name: 'binary', digest: 'sha256:bad' })).toThrow();
    expect(() => assetDigest(undefined)).toThrow();
  });
  it('清除真实模型与录制开关，同时保留显式旧二进制', () => {
    const env = validationEnv('/candidate', {
      PATH: '/tools',
      WEVIR_TEST_API_KEY: 'not-a-real-key',
      WEVIR_TEST_CLAUDE: '1',
      WEVIR_TEST_PROVIDER: 'live',
      WEVIR_BASELINE_AB: 'full,core',
      WEVIR_RECORD_CODEX: '1',
      WEVIR_MEASURE_CODEX: '1',
      WEVIR_CODING_EVAL: '1',
      WEVIR_EVAL_DEEPSEEK_KEY: 'not-a-real-key',
      WEVIR_EVAL_KIMI_KEY: 'not-a-real-key',
      WEVIR_CODEX_BIN: '/old',
      WEVIR_CODEX_LEGACY_BIN: '/legacy',
    });
    expect(env).toEqual({
      PATH: '/tools',
      WEVIR_CODEX_BIN: '/candidate',
      WEVIR_CODEX_LEGACY_BIN: '/legacy',
      WEVIR_TEST_API_KEY: '',
      WEVIR_TEST_PROVIDER: '',
      WEVIR_BASELINE: '1',
    });
  });
});
