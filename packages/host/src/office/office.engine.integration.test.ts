// 预览引擎的真实测试：从 npm registry 下载本平台的 LibreOffice 引擎（macOS、Windows 原生，Linux WebAssembly），把 fixtures/ 里的
// docx、pptx、xlsx 转成 PDF。默认跳过；设 `WEVIR_TEST_OFFICE_DIR` 为一个目录（引擎装在它的 engine/ 下，装过的不再下载）。
// CI 在三个平台都跑（ci.yml 缓存 .wevir-dev/office）。

import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { officeEngineBackend } from './engine.js';
import { OfficeService } from './service.js';

const directory = process.env.WEVIR_TEST_OFFICE_DIR;
const skip = directory === undefined || directory === '' || officeEngineBackend() === undefined;
if (skip) {
  console.log(
    '跳过预览引擎的真实测试：设 WEVIR_TEST_OFFICE_DIR（引擎约 50–75 MB，下载到它的 engine/ 下）',
  );
}

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'wevir-office-engine-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(skip)('预览引擎（真实下载与转换）', () => {
  const service = new OfficeService({ directory: resolve(directory ?? '.') });
  afterAll(() => service.dispose());

  it('下载并装好本平台的引擎', async () => {
    await service.init();
    if (service.status().state !== 'ready') {
      service.install();
      await new Promise<void>((done, fail) => {
        const stop = service.watch((status) => {
          if (status.state === 'ready') {
            stop();
            done();
          } else if (status.state === 'failed') {
            stop();
            fail(new Error(status.error));
          }
        });
      });
    }
    expect(service.status()).toMatchObject({ state: 'ready', backend: officeEngineBackend() });
  }, 600_000);

  it.each([
    ['report.docx', 1],
    ['deck.pptx', 2],
    ['sheet.xlsx', 1],
  ])(
    '%s 转成 %i 页的 PDF',
    async (name, pages) => {
      // 每次复制一份：修改时间不同，不命中上一次 CI 留下的缓存。
      const real = join(work, name);
      copyFileSync(join(fixtures, name), real);
      const { size, mtimeMs } = statSync(real);
      const pdf = await service.convert({ real, size, mtimeMs: mtimeMs + Math.random() });
      expect(pdf.pageCount).toBe(pages);
      const bytes = readFileSync(join(service.pdfDirectory, pdf.file));
      expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    },
    180_000,
  );
});
