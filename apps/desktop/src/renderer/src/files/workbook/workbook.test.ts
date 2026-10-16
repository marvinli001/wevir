// OpenWork 的 workbook（移植）：写一个 xlsx 再读回来，docx / pptx 抽文字。

import { describe, expect, it } from 'vitest';
import {
  buildZip,
  extractOfficeText,
  officeKindFromMimeOrFilename,
  openXlsxWorkbook,
  sheetGridRows,
  utf8Bytes,
  writeXlsxWorkbook,
} from './index';

describe('xlsx', () => {
  it('写出的工作簿读得回来：多个工作表、数字、布尔与公式', async () => {
    const { bytes } = await writeXlsxWorkbook([
      {
        name: '销售',
        rows: [
          ['地区', '金额', '完成'],
          ['华东', 1200.5, true],
          ['华南', 800, false],
          ['合计', { formula: 'SUM(B2:B3)' }, null],
        ],
      },
      { name: 'Notes', header: false, rows: [['=not a formula']] },
    ]);
    const workbook = await openXlsxWorkbook(bytes);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['销售', 'Notes']);
    const first = await workbook.readSheet(workbook.sheets[0] as (typeof workbook.sheets)[number]);
    const grid = sheetGridRows(first);
    expect(grid[0]).toEqual(['地区', '金额', '完成']);
    expect(grid[1]).toEqual(['华东', '1200.5', 'TRUE']);
    expect(grid[2]).toEqual(['华南', '800', 'FALSE']);
    expect(grid[3]?.[1]).toBe('=SUM(B2:B3)');
    const notes = await workbook.readSheet(workbook.sheets[1] as (typeof workbook.sheets)[number]);
    // 文本永远是文本，不会变成公式。
    expect(sheetGridRows(notes)).toEqual([['=not a formula']]);
  });

  it('不是 zip 时报错', async () => {
    await expect(openXlsxWorkbook(utf8Bytes('not a zip'))).rejects.toThrow();
  });
});

describe('Office 文字', () => {
  it('docx 的正文与 pptx 的幻灯片', async () => {
    expect(officeKindFromMimeOrFilename('', 'a/Letter.docx')).toBe('docx');
    expect(officeKindFromMimeOrFilename('application/pdf', 'a.docx')).toBeNull();
    const docx = await buildZip([
      {
        name: 'word/document.xml',
        data: utf8Bytes(
          '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; last</w:t></w:r></w:p></w:body></w:document>',
        ),
      },
    ]);
    const text = await extractOfficeText('docx', docx);
    expect(text).toContain('第一段');
    expect(text).toContain('Second & last');
    const pptx = await buildZip([
      { name: 'ppt/slides/slide2.xml', data: utf8Bytes('<p:sld><a:t>Two</a:t></p:sld>') },
      { name: 'ppt/slides/slide1.xml', data: utf8Bytes('<p:sld><a:t>One</a:t></p:sld>') },
    ]);
    const slides = await extractOfficeText('pptx', pptx);
    expect(slides.indexOf('One')).toBeLessThan(slides.indexOf('Two'));
  });
});
