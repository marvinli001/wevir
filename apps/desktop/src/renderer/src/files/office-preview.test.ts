import { describe, expect, it } from 'vitest';
import { officePreview } from './office-preview';
import { buildZip, utf8Bytes } from './workbook';

describe('officePreview', () => {
  it('docx 按段落，正文在前，页眉另成一段', async () => {
    const docx = await buildZip([
      {
        name: 'word/header1.xml',
        data: utf8Bytes('<w:hdr xmlns:w="w"><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>'),
      },
      {
        name: 'word/document.xml',
        data: utf8Bytes(
          '<w:document xmlns:w="w"><w:body><w:p><w:pPr/><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> 续</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>Second &amp; last</w:t></w:r></w:p></w:body></w:document>',
        ),
      },
    ]);
    expect(await officePreview('docx', docx)).toEqual({
      sections: [
        { kind: 'body', paragraphs: ['第一段 续', 'Second & last'] },
        { kind: 'part', label: 'header1', paragraphs: ['页眉'] },
      ],
      truncated: false,
    });
  });

  it('pptx 按幻灯片编号排序，备注跟在后面', async () => {
    const pptx = await buildZip([
      {
        name: 'ppt/slides/slide10.xml',
        data: utf8Bytes('<p:sld><a:p><a:t>Ten</a:t></a:p></p:sld>'),
      },
      {
        name: 'ppt/notesSlides/notesSlide2.xml',
        data: utf8Bytes('<p:notes><a:p><a:t>note</a:t></a:p></p:notes>'),
      },
      {
        name: 'ppt/slides/slide2.xml',
        data: utf8Bytes('<p:sld><a:p><a:t>Two</a:t></a:p><a:p><a:t>more</a:t></a:p></p:sld>'),
      },
    ]);
    const { sections } = await officePreview('pptx', pptx);
    expect(sections.map((section) => [section.kind, section.label, section.paragraphs])).toEqual([
      ['slide', '2', ['Two', 'more']],
      ['notes', '2', ['note']],
      ['slide', '10', ['Ten']],
    ]);
  });

  it('没有正文部件时报错', async () => {
    await expect(
      officePreview('docx', await buildZip([{ name: 'a.txt', data: utf8Bytes('x') }])),
    ).rejects.toThrow();
  });
});
