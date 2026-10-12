// 验收：fixtures/ 与 .dsh-home/ 中不得出现密钥；fixtures/ 中不得出现个人路径。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { currentTarget, DSH_HOME, FIXTURES_DIR, KEY_ENV, SPIKE_DIR } from '../env.ts';
import { expect, record } from '../report.ts';

const STEP = 'check-secrets';
// 常见 API Key 形态：OpenAI/DeepSeek 风格 sk-…、Bearer 头、YAML/JSON 里的明文 apiKey 字段
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /["']?apiKey["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/,
];

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      // dsh profile 目录可能装有插件依赖；只扫描数据文件
      if (entry === 'node_modules') continue;
      yield* walk(path);
    } else if (st.size < 32 * 1024 * 1024) {
      yield path;
    }
  }
}

function scan(dir: string, needles: Array<string | RegExp>): string[] {
  const hits: string[] = [];
  for (const file of walk(dir)) {
    // dsh 的会话日志是 session.vN.jsonl.zstd，先解压再匹配，否则看不到里面的明文
    const raw = readFileSync(file);
    const text = (file.endsWith('.zstd') ? zstdDecompressSync(raw) : raw).toString('utf8');
    for (const needle of needles) {
      const found = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
      if (found) hits.push(`${relative(SPIKE_DIR, file)} ~ ${String(needle).slice(0, 24)}`);
    }
  }
  return hits;
}

export async function checkSecrets(): Promise<void> {
  console.log('\n▶ 密钥与个人信息检查');
  // 本次注入子进程的 Key（真实 Key，或 mock 模式下的假 Key）都不应出现在任何落盘文件里
  const key = currentTarget()?.key || process.env[KEY_ENV];
  const needles: Array<string | RegExp> = [...KEY_PATTERNS];
  if (key !== undefined && key.length > 0) needles.push(key);
  const files = [...walk(FIXTURES_DIR)].length + [...walk(DSH_HOME)].length;
  const fixtureHits = scan(FIXTURES_DIR, needles);
  const homeHits = scan(DSH_HOME, needles);
  expect(
    STEP,
    `fixtures/ 中没有密钥${key ? '（含本次 Key 原文）' : ''}`,
    fixtureHits.length === 0,
    fixtureHits,
  );
  expect(
    STEP,
    `.dsh-home/ 中没有密钥${key ? '（含本次 Key 原文）' : ''}`,
    homeHits.length === 0,
    homeHits,
  );
  expect(
    STEP,
    '.dsh-home/.credentials.yaml 未被创建',
    !existsSync(join(DSH_HOME, '.credentials.yaml')),
  );
  const personal = [homedir(), process.env.USER ?? ''].filter((s) => s.length > 2);
  const personalHits = scan(FIXTURES_DIR, personal);
  expect(STEP, 'fixtures/ 中没有个人路径或用户名', personalHits.length === 0, personalHits);
  record(STEP, '扫描文件数', 'observe', files);
}
