// docx / pptx 在文件窗格里的文字预览（0.32.0）：用 OpenWork 的 OOXML 读取（workbook/ooxml-package.ts，带它的大小与压缩比上限）
// 按段落取文字。OpenWork 的 extractOfficeText 是给模型的，把空白压成一行；预览要保留段落，部件的选取规则照它
// （relevantXmlEntry：正文、页眉页脚、脚注尾注、批注；幻灯片与备注）。纯逻辑。

import type { OfficeKind } from './file-preview';
import { listZipEntries, readZipEntryData, utf8Text, xmlText } from './workbook';
import { xmlBlocks } from './workbook/ooxml-package';

/** 最多显示的字数，多了截断。 */
export const OFFICE_PREVIEW_MAX_CHARS = 200_000;

export interface OfficeSection {
  /** 部件：`body`（Word 正文）、`slide` / `notes`（带编号）或别的 Word 部件（页眉、脚注等，取文件名）。 */
  kind: 'body' | 'slide' | 'notes' | 'part';
  /** 幻灯片的编号或部件的文件名。 */
  label?: string;
  paragraphs: string[];
}

function partOf(kind: Exclude<OfficeKind, 'xlsx'>, name: string): OfficeSection | undefined {
  if (kind === 'docx') {
    if (name === 'word/document.xml') return { kind: 'body', paragraphs: [] };
    if (
      /^word\/(header|footer)\d+\.xml$/.test(name) ||
      /^word\/(footnotes|endnotes|comments)\.xml$/.test(name)
    ) {
      return { kind: 'part', label: name.slice('word/'.length, -'.xml'.length), paragraphs: [] };
    }
    return undefined;
  }
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
  if (slide) return { kind: 'slide', label: slide[1], paragraphs: [] };
  const notes = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name);
  if (notes) return { kind: 'notes', label: notes[1], paragraphs: [] };
  return undefined;
}

/** 部件的顺序：Word 正文在前；幻灯片按编号，备注跟在它的幻灯片后面。 */
function order(section: OfficeSection): number {
  if (section.kind === 'body') return 0;
  const n = Number(section.label);
  if (section.kind === 'slide') return n * 2;
  if (section.kind === 'notes') return n * 2 + 1;
  return 1_000_000;
}

/** 按段落（`w:p` / `a:p`）取文字；空段落不要。总字数超过上限时截断，`truncated` 为 true。 */
export async function officePreview(
  kind: Exclude<OfficeKind, 'xlsx'>,
  bytes: Uint8Array,
): Promise<{ sections: OfficeSection[]; truncated: boolean }> {
  const sections: Array<OfficeSection & { entry: ReturnType<typeof listZipEntries>[number] }> = [];
  for (const entry of listZipEntries(bytes)) {
    const section = partOf(kind, entry.name);
    if (section) sections.push({ ...section, entry });
  }
  sections.sort((a, b) => order(a) - order(b) || a.entry.name.localeCompare(b.entry.name));
  let remaining = OFFICE_PREVIEW_MAX_CHARS;
  let truncated = false;
  const result: OfficeSection[] = [];
  for (const { entry, ...section } of sections) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const xml = utf8Text(await readZipEntryData(bytes, entry));
    for (const block of xmlBlocks(xml, 'p')) {
      const text = xmlText(block.inner);
      if (!text) continue;
      const kept = text.slice(0, remaining);
      section.paragraphs.push(kept);
      remaining -= kept.length;
      if (remaining <= 0) {
        truncated = kept.length < text.length || truncated;
        break;
      }
    }
    if (section.paragraphs.length > 0) result.push(section);
  }
  if (result.length === 0 && sections.length === 0) {
    throw new Error('No supported Office XML text entries were found.');
  }
  return { sections: result, truncated };
}
