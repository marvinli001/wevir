import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { WebService, webSecretRef } from './service.js';

// 联网工具的第 3 层：真实的搜索服务与真实的网页（docs/development.md §6.3）。用环境变量里的 Key，没有就跳过并打印原因；Key 只在
// 进程环境与临时数据目录里，测试结束删掉。联网、会用掉一点额度。
//   WEVIR_TEST_BOCHA_API_KEY   博查开放平台的 API Key
//   WEVIR_TEST_TAVILY_API_KEY  Tavily 的 API Key（tvly-…）
//   WEVIR_TEST_WEB_FETCH=1     抓一个公开网页（https://example.com/），不需要 Key

const KEYS = {
  bocha: process.env.WEVIR_TEST_BOCHA_API_KEY,
  tavily: process.env.WEVIR_TEST_TAVILY_API_KEY,
};
const FETCH = process.env.WEVIR_TEST_WEB_FETCH === '1';

for (const [service, key] of Object.entries(KEYS)) {
  if (key === undefined || key === '') {
    console.warn(
      `[web.contract] 跳过 ${service}：没有设 WEVIR_TEST_${service.toUpperCase()}_API_KEY`,
    );
  }
}
if (!FETCH) console.warn('[web.contract] 跳过真实网页：没有设 WEVIR_TEST_WEB_FETCH=1');

let root: string | undefined;
let service: WebService | undefined;

afterEach(async () => {
  await service?.close();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

async function start(keys: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'wevir-web-contract-'));
  const secrets = new FileSecretStore(root);
  for (const [id, key] of Object.entries(keys)) await secrets.set(webSecretRef(id), key);
  service = new WebService({ settingsFile: join(root, 'web.json'), mcpDir: join(root, 'mcp') });
  await service.start(secrets);
  return service;
}

describe.each(Object.entries(KEYS))('真实搜索服务：%s', (id, key) => {
  it.skipIf(key === undefined || key === '')(
    'web.test 通过；web_search 返回带链接的结果',
    { timeout: 60_000 },
    async () => {
      const web = await start({ [id]: key as string });
      await web.update({ searchService: id });
      const tested = await web.test({});
      expect(tested, JSON.stringify(tested)).toMatchObject({ ok: true, service: id });
      const result = await web.call('web_search', { query: 'Node.js 最新 LTS 版本', count: 3 });
      const text = result.content.map((part) => part.text).join('\n');
      expect(result.isError, text).toBeUndefined();
      expect(text).toMatch(/\[1\] .+\nURL: https?:\/\//);
      expect(text).not.toContain(key as string);
    },
  );
});

describe('真实网页', () => {
  it.skipIf(!FETCH)('web_fetch 读 https://example.com/', { timeout: 60_000 }, async () => {
    const web = await start({});
    const result = await web.call('web_fetch', { url: 'https://example.com/' });
    const text = result.content.map((part) => part.text).join('\n');
    expect(result.isError, text).toBeUndefined();
    expect(text).toContain('Title: Example Domain');
  });
});
