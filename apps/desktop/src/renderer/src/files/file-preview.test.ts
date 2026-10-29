import { describe, expect, it } from 'vitest';
import { filePreviewDelimiter, parseDelimitedPreview } from './delimited-preview';
import {
  filePaneView,
  filePreviewKind,
  isStreamedView,
  officePdfConvertible,
  videoMimeType,
} from './file-preview';

describe('filePreviewKind（T3）', () => {
  it('按扩展名与 MIME 分类', () => {
    expect(filePreviewKind({ name: 'a/report.PDF' })).toBe('pdf');
    expect(filePreviewKind({ name: 'site/index.htm' })).toBe('html');
    expect(filePreviewKind({ name: 'README.mdx' })).toBe('markdown');
    expect(filePreviewKind({ name: 'shot.webp' })).toBe('image');
    expect(filePreviewKind({ name: 'clip.mov' })).toBe('video');
    expect(filePreviewKind({ name: 'voice.m4a' })).toBe('audio');
    expect(filePreviewKind({ name: 'Dockerfile' })).toBe('text');
    expect(filePreviewKind({ name: 'a.bin' })).toBe('unsupported');
    // 明确的 MIME 优先于扩展名。
    expect(filePreviewKind({ name: 'a.mp4', mimeType: 'application/pdf' })).toBe('pdf');
    expect(videoMimeType({ name: 'a.mp4', mimeType: 'application/pdf' })).toBeNull();
  });
});

describe('filePaneView', () => {
  it('窗格的显示方式', () => {
    expect(filePaneView('book.xlsx')).toBe('spreadsheet');
    expect(filePaneView('letter.DOCX')).toBe('document');
    expect(filePaneView('deck.pptx')).toBe('document');
    expect(filePaneView('old.xls')).toBe('office');
    expect(filePaneView('talk.key')).toBe('office');
    expect(filePaneView('data.csv')).toBe('table');
    expect(filePaneView('data.tsv')).toBe('table');
    expect(filePaneView('notes.md')).toBe('markdown');
    expect(filePaneView('page.html')).toBe('html');
    expect(filePaneView('a.unknownext')).toBe('text');
    expect(filePaneView('Makefile')).toBe('text');
    expect(isStreamedView('pdf')).toBe(true);
    expect(isStreamedView('html')).toBe(false);
    expect(isStreamedView('table')).toBe(false);
  });
});

describe('parseDelimitedPreview（T3）', () => {
  it('引号里的分隔符、转义的引号、跨行的格', () => {
    expect(filePreviewDelimiter({ name: 'a.TSV' })).toBe('\t');
    expect(filePreviewDelimiter({ name: 'a.txt' })).toBeNull();
    const parsed = parseDelimitedPreview('﻿name,note\r\n"Ada, L.","say ""hi""\nthere"\nBob,', ',');
    expect(parsed).toEqual({
      rows: [
        ['name', 'note'],
        ['Ada, L.', 'say "hi"\nthere'],
        ['Bob', ''],
      ],
      truncated: false,
    });
  });

  it('超过 100 行、30 列时截断', () => {
    const wide = Array.from({ length: 31 }, (_, index) => `c${index}`).join(',');
    expect(parseDelimitedPreview(wide, ',')).toMatchObject({ truncated: true });
    const tall = Array.from({ length: 101 }, (_, index) => `${index}`).join('\n');
    const parsed = parseDelimitedPreview(tall, ',');
    expect(parsed.rows).toHaveLength(100);
    expect(parsed.truncated).toBe(true);
  });
});

describe('officePdfConvertible（0.138.0）', () => {
  it('Word、Excel、PowerPoint 与 OpenDocument 能转成 PDF；iWork、RTF 与别的格式不能', () => {
    for (const path of [
      'a.docx',
      'b/C.DOC',
      'c.odt',
      'd.xlsx',
      'e.xls',
      'f.ods',
      'g.pptx',
      'h.ppt',
      'i.odp',
    ]) {
      expect(officePdfConvertible(path), path).toBe(true);
    }
    for (const path of ['a.pages', 'b.key', 'c.numbers', 'd.rtf', 'e.pdf', 'f.md', 'docx']) {
      expect(officePdfConvertible(path), path).toBe(false);
    }
  });
});
