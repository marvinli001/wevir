import type { ToolDisplay } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import { DSH_TOOLS, parseTodoItems, toolDisplay } from './tool-display.js';

// rawInput 的字段名：✅ 的取自 T0.3 样本，其余取自上游 d743267 的工具定义（acp-event-mapping.md §2）。
const CASES: Array<[string, unknown, ToolDisplay]> = [
  [
    'read',
    { file_path: 'input.csv' },
    { kind: 'read', summary: 'input.csv', paths: ['input.csv'] },
  ],
  ['read_image', { file_path: 'a.png' }, { kind: 'read', summary: 'a.png', paths: ['a.png'] }],
  [
    'write',
    { file_path: 'rows.txt', content: '3\n', sandbox_permissions: 'danger-full-access' },
    { kind: 'write', summary: 'rows.txt', paths: ['rows.txt'] },
  ],
  [
    'edit',
    { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
    { kind: 'edit', summary: 'a.ts', paths: ['a.ts'] },
  ],
  [
    'str_replace_editor',
    { command: 'str_replace', path: 'a.ts' },
    { kind: 'edit', summary: 'a.ts', paths: ['a.ts'] },
  ],
  [
    'bash',
    { command: 'sleep 45 && echo finished', description: 'Sleep 45s' },
    { kind: 'shell', command: 'sleep 45 && echo finished', summary: 'sleep 45 && echo finished' },
  ],
  [
    'pwsh',
    { command: '\nGet-ChildItem\nGet-Date' },
    { kind: 'shell', command: '\nGet-ChildItem\nGet-Date', summary: 'Get-ChildItem' },
  ],
  ['job_output', { job_id: 'job-1' }, { kind: 'shell', summary: 'job-1' }],
  ['job_list', {}, { kind: 'shell' }],
  ['job_kill', { job_id: 'job-1' }, { kind: 'shell', summary: 'job-1' }],
  [
    'grep',
    { pattern: 'TODO', path: 'src' },
    { kind: 'search', query: 'TODO', summary: 'TODO', paths: ['src'] },
  ],
  ['glob', { pattern: '**/*.ts' }, { kind: 'search', query: '**/*.ts', summary: '**/*.ts' }],
  [
    'web_search',
    { queries: ['杭州 天气', 'west lake'] },
    { kind: 'search', query: '杭州 天气 | west lake', summary: '杭州 天气 | west lake' },
  ],
  [
    'web_fetch',
    { url: 'https://example.com' },
    { kind: 'fetch', url: 'https://example.com', summary: 'https://example.com' },
  ],
  ['todo_write', { todos: [] }, { kind: 'plan' }],
  ['plan', { plan: '# 迁移计划\n\n1. …' }, { kind: 'plan', summary: '迁移计划' }],
  [
    'subagent',
    { description: '统计数据行数', prompt: '读取 input.csv' },
    { kind: 'sub_agent', summary: '统计数据行数' },
  ],
  ['send_message', { message: 'hi' }, { kind: 'sub_agent' }],
  ['interrupt_agent', {}, { kind: 'sub_agent' }],
  ['list_agents', {}, { kind: 'sub_agent' }],
  ['list_subagent_models', {}, { kind: 'sub_agent' }],
  [
    'present',
    { files: [{ path: 'report.md', description: '周报' }, { path: '' }, 'bad'] },
    { kind: 'unknown', paths: ['report.md'] },
  ],
];

describe('toolDisplay', () => {
  it.each(CASES)('%s', (name, input, expected) => {
    expect(toolDisplay(name, input)).toEqual(expected);
  });

  it('表里的每个工具都有用例', () => {
    expect(CASES.map(([name]) => name).sort()).toEqual(Object.keys(DSH_TOOLS).sort());
  });

  it('mcp__<server>__<tool>：unknown，带 server 名', () => {
    expect(toolDisplay('mcp__github__create_issue', { title: 'x' })).toEqual({
      kind: 'unknown',
      mcpServer: 'github',
    });
  });

  it('不认识的工具名、原型链上的名字：unknown', () => {
    expect(toolDisplay('lsp', { file_path: 'a.ts' })).toEqual({ kind: 'unknown' });
    expect(toolDisplay('toString', {})).toEqual({ kind: 'unknown' });
  });

  it('rawInput 不是对象（dsh 解析模型 JSON 失败时给原始字符串）或字段类型不对：只少字段', () => {
    expect(toolDisplay('read', '{"file_path": "a')).toEqual({ kind: 'read' });
    expect(toolDisplay('bash', { command: 42 })).toEqual({ kind: 'shell' });
    expect(toolDisplay('write', null)).toEqual({ kind: 'write' });
  });
});

describe('parseTodoItems', () => {
  it('完整列表，status 原样保留', () => {
    expect(
      parseTodoItems({
        todos: [
          { content: '读取', status: 'completed' },
          { content: '汇总', status: 'blocked', priority: 'high' },
        ],
      }),
    ).toEqual([
      { content: '读取', status: 'completed' },
      { content: '汇总', status: 'blocked' },
    ]);
  });

  it('空列表是合法的（全部清掉）', () => {
    expect(parseTodoItems({ todos: [] })).toEqual([]);
  });

  it('结构不对或有一项缺字段：undefined，不发半截列表', () => {
    expect(parseTodoItems(undefined)).toBeUndefined();
    expect(parseTodoItems({ todos: 'x' })).toBeUndefined();
    expect(
      parseTodoItems({ todos: [{ content: 'a', status: 'pending' }, { content: 'b' }] }),
    ).toBeUndefined();
  });
});
