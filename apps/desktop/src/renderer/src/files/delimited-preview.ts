// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/delimitedPreview.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：无（格式交给 Biome）。
//
// CSV / TSV 的表格预览（文件窗格，0.32.0）：最多 100 行、30 列、每格 2000 个字符，多出的标 `truncated`。纯逻辑。

/** A table preview is bounded independently of the source preview's byte limit. */
export function filePreviewDelimiter(file: { name: string; mimeType?: string }): ',' | '\t' | null {
  const mime = file.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (mime === 'text/csv') return ',';
  if (mime === 'text/tab-separated-values') return '\t';
  if (mime && mime !== 'text/plain' && mime !== 'application/octet-stream') return null;
  if (/\.csv$/i.test(file.name)) return ',';
  if (/\.tsv$/i.test(file.name)) return '\t';
  return null;
}

/** Preserve quoted delimiters, escaped quotes and multiline cells; raw mode retains all text. */
export function parseDelimitedPreview(text: string, delimiter: ',' | '\t') {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  let rowStart = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endCell = () => {
    if (row.length < 30) row.push(cell);
    else truncated = true;
    cell = '';
  };
  for (let index = rowStart; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        if (cell.length < 2000) cell += '"';
        else truncated = true;
        index++;
        continue;
      }
      if (quoted || cell === '') {
        quoted = !quoted;
        continue;
      }
    }
    if (!quoted && (char === delimiter || char === '\n' || char === '\r')) {
      endCell();
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === '\r' && text[index + 1] === '\n') index++;
        rowStart = index + 1;
        if (rows.length === 100) return { rows, truncated: truncated || index < text.length - 1 };
      }
    } else if (cell.length < 2000) cell += char;
    else truncated = true;
  }
  if (rowStart < text.length) {
    endCell();
    rows.push(row);
  }
  return { rows, truncated: truncated || quoted };
}
