import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BasePrompt,
  defaultPromptsDir,
  promptReader,
  renderPromptTemplate,
  resolvePromptsDir,
} from './prompts.js';

const none = () => {
  throw new Error('不该引入');
};

describe('renderPromptTemplate（prompts/README.md 模板语法）', () => {
  it('先删注释，再替换变量；去掉开头的空行', () => {
    expect(
      renderPromptTemplate(
        '<!-- 头 {{ x }} -->\n\n你好 {{ name }}，{{name}}。<!-- 尾 -->',
        { name: '甲' },
        none,
      ),
    ).toBe('你好 甲，甲。');
  });

  it('引入另一个文件（同样先删注释）', () => {
    const files: Record<string, string> = { 'shared/a.md': '<!-- c -->A={{ v }}' };
    expect(
      renderPromptTemplate('x {{> shared/a.md }} y', { v: '1' }, (path) => files[path] ?? ''),
    ).toBe('x A=1 y');
  });

  it('变量缺失、残留 {{ 都报错', () => {
    expect(() => renderPromptTemplate('{{ missing }}', {}, none)).toThrow('missing');
    expect(() => renderPromptTemplate('a {{ b', {}, none)).toThrow('残留');
  });

  it('循环引入报错', () => {
    expect(() => renderPromptTemplate('{{> a.md }}', {}, () => '{{> a.md }}')).toThrow('层数');
  });
});

describe('promptReader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-prompts-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('只能读 prompts/ 里的文件', () => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'x.md'), 'X');
    const read = promptReader(dir);
    expect(read('sub/x.md')).toBe('X');
    expect(() => read('../outside.md')).toThrow('越出');
  });
});

describe('resolvePromptsDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-prompts-resources-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('资源目录里有 prompts/base.md 时用它（安装包），否则用仓库的 prompts/', () => {
    expect(resolvePromptsDir({})).toBe(defaultPromptsDir());
    expect(resolvePromptsDir({ WEVIR_RESOURCES_DIR: '' })).toBe(defaultPromptsDir());
    // 开发构建上模拟安装布局时资源目录可能只有二进制（development.md §3.5）。
    expect(resolvePromptsDir({ WEVIR_RESOURCES_DIR: dir }, '/repo/prompts')).toBe('/repo/prompts');
    mkdirSync(join(dir, 'prompts'));
    writeFileSync(join(dir, 'prompts', 'base.md'), '');
    expect(resolvePromptsDir({ WEVIR_RESOURCES_DIR: dir }, '/repo/prompts')).toBe(
      join(dir, 'prompts'),
    );
  });
});

describe('仓库的 base.md', () => {
  it('渲染后没有注释、没有 {{，自报 Wevir 与底层模型、Provider', () => {
    const text = new BasePrompt().render({
      model_display_name: 'DeepSeek Flash',
      provider_display_name: 'DeepSeek 官方',
    });
    expect(text.startsWith('你是 Wevir 里的 Agent')).toBe(true);
    expect(text).toContain('底层模型是 DeepSeek Flash，由 DeepSeek 官方 提供');
    expect(text).not.toContain('<!--');
    expect(text).not.toContain('{{');
    // 工具说明与 adapter-codex 的配置一致（prompts/README.md：配置变了要同步改 base.md）。
    expect(text).toContain('## update_plan');
    // 联网用 Wevir 自己的 wevir_web（0.34.0），工具名与 web-tool.ts 的一致。
    expect(text).toContain('wevir_web.web_search');
    expect(text).toContain('`web_fetch`');
    expect(text).not.toContain('本回合没有联网搜索工具');
  });
});
