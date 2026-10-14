import { describe, expect, it } from 'vitest';
import type { CommandAction, ToolItem } from './protocol.js';
import {
  commandDisplay,
  displayCommand,
  fileChangeDisplay,
  isToolItem,
  toolDisplay,
  toolName,
} from './tool-display.js';

describe('displayCommand', () => {
  it('去掉 <shell> -lc 的外壳', () => {
    expect(displayCommand("/bin/zsh -lc 'cat README.md'")).toBe('cat README.md');
    expect(displayCommand('/bin/zsh -lc ls')).toBe('ls');
    expect(displayCommand("bash -c 'echo hi'")).toBe('echo hi');
    expect(displayCommand("/usr/bin/bash -lc 'echo '\\''quoted'\\'''")).toBe("echo 'quoted'");
    expect(displayCommand("sh -lc 'a\nb'")).toBe('a\nb');
  });

  it('认不出外壳时用唯一的解析动作，否则原样', () => {
    const one: CommandAction[] = [{ type: 'unknown', command: 'dir' }];
    expect(displayCommand('powershell.exe -Command dir', one)).toBe('dir');
    expect(displayCommand('powershell.exe -Command dir')).toBe('powershell.exe -Command dir');
  });
});

describe('commandDisplay', () => {
  const read = (path: string): CommandAction => ({
    type: 'read',
    command: `cat ${path}`,
    name: path,
    path,
  });

  it('全是 read：read，路径去重', () => {
    expect(
      commandDisplay({
        command: "zsh -lc 'cat a b a'",
        commandActions: [read('a'), read('b'), read('a')],
      }),
    ).toEqual({ kind: 'read', summary: 'a, b', paths: ['a', 'b'], command: 'cat a b a' });
  });

  it('读取 / 列目录 / 搜索混合：search，query 取第一个搜索词', () => {
    expect(
      commandDisplay({
        command: "zsh -lc 'ls src && rg foo src'",
        commandActions: [
          { type: 'listFiles', command: 'ls src', path: 'src' },
          { type: 'search', command: 'rg foo src', query: 'foo', path: 'src' },
        ],
      }),
    ).toEqual({
      kind: 'search',
      summary: 'foo',
      paths: ['src'],
      query: 'foo',
      command: 'ls src && rg foo src',
    });
  });

  it('有 unknown 或没有解析结果：shell', () => {
    expect(
      commandDisplay({
        command: "zsh -lc 'cat a && make'",
        commandActions: [read('a'), { type: 'unknown', command: 'make' }],
      }),
    ).toEqual({ kind: 'shell', summary: 'cat a && make', command: 'cat a && make' });
    expect(commandDisplay({ command: 'make', commandActions: [] })).toMatchObject({
      kind: 'shell',
    });
  });
});

describe('fileChangeDisplay', () => {
  it('全是新建是 write，否则 edit；移动取目标路径', () => {
    expect(fileChangeDisplay([{ path: 'a', kind: { type: 'add' }, diff: '' }])).toEqual({
      kind: 'write',
      summary: 'a',
      paths: ['a'],
    });
    expect(
      fileChangeDisplay([
        { path: 'a', kind: { type: 'add' }, diff: '' },
        { path: 'b', kind: { type: 'update', move_path: 'c' }, diff: '' },
        { path: 'd', kind: { type: 'delete' }, diff: '' },
      ]),
    ).toEqual({ kind: 'edit', summary: 'a 等 3 个文件', paths: ['a', 'c', 'd'] });
  });
});

describe('工具名与其他 item', () => {
  it('MCP、动态工具、子 agent、图片', () => {
    const mcp: ToolItem = {
      type: 'mcpToolCall',
      id: '1',
      server: 'fs',
      tool: 'read',
      status: 'completed',
      arguments: {},
      result: null,
      error: null,
    };
    expect(toolName(mcp)).toBe('mcp__fs__read');
    expect(toolDisplay(mcp)).toEqual({ kind: 'unknown', summary: 'fs/read', mcpServer: 'fs' });
    const dynamic: ToolItem = {
      type: 'dynamicToolCall',
      id: '2',
      namespace: 'ns',
      tool: 't',
      arguments: {},
      status: 'completed',
      contentItems: null,
      success: null,
    };
    expect(toolName(dynamic)).toBe('ns.t');
    const collab: ToolItem = {
      type: 'collabAgentToolCall',
      id: '3',
      tool: 'wait',
      status: 'completed',
      senderThreadId: 'p',
      receiverThreadIds: ['c'],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    };
    expect(toolName(collab)).toBe('collabAgentToolCall.wait');
    expect(toolDisplay(collab)).toEqual({ kind: 'sub_agent', summary: 'wait' });
    expect(toolDisplay({ type: 'imageView', id: '4', path: '/a.png' })).toEqual({
      kind: 'read',
      summary: '/a.png',
      paths: ['/a.png'],
    });
  });

  it('isToolItem 检查映射要读的字段', () => {
    expect(isToolItem({ type: 'commandExecution', command: 'ls' })).toBe(true);
    expect(isToolItem({ type: 'commandExecution' })).toBe(false);
    expect(
      isToolItem({ type: 'fileChange', changes: [{ path: 'a', kind: { type: 'add' } }] }),
    ).toBe(true);
    expect(isToolItem({ type: 'fileChange', changes: [{ path: 'a' }] })).toBe(false);
    expect(isToolItem({ type: 'agentMessage', text: '' })).toBe(false);
  });
});
