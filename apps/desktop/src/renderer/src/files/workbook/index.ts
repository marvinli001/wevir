// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork packages/workbook/src/index.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：只有格式（Biome）、相对导入去掉 .js 后缀、几处 biome-ignore 注释与 noUncheckedIndexedAccess 要的类型断言，逻辑不改。
//

export {
  DOCX_MIME,
  extractOfficeText,
  MAX_OFFICE_TEXT_CHARS,
  type OfficeKind,
  type OfficeTextOptions,
  officeKindFromMimeOrFilename,
  PPTX_MIME,
  XLSX_MIME,
} from './office-text';
export {
  buildZip,
  listZipEntries,
  MAX_COMPRESSED_BYTES,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  readZipEntryData,
  readZipTextEntry,
  utf8Bytes,
  utf8Text,
  xmlText,
  type ZipEntry,
  type ZipFileInput,
  zipEntryMap,
} from './ooxml-package';
export {
  type CellRange,
  cellInputFromText,
  columnIndex,
  columnLetters,
  excelSerialToIso,
  findSheet,
  formulaSummary,
  isDateNumberFormat,
  isFormulaInput,
  numberFormatSummary,
  openXlsxWorkbook,
  parseCellReference,
  parseRange,
  renderSheetTable,
  sheetGridRows,
  sheetHeaderRow,
  unsafeFormulaReason,
  writeXlsxWorkbook,
  XLSX_MAX_SHEETS,
  XLSX_WRITE_MAX_CELLS,
  XLSX_WRITE_MAX_SHEETS,
  type XlsxCell,
  type XlsxCellInput,
  type XlsxFormulaInput,
  type XlsxSheetData,
  type XlsxSheetInfo,
  type XlsxSheetInput,
  type XlsxTable,
  type XlsxTableOptions,
  type XlsxWorkbook,
  type XlsxWriteResult,
} from './xlsx-workbook';
