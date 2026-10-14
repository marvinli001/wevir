import { describe, expect, it } from 'vitest';
import { customCallInput, flatToolName, restoreToolCall, ToolNames } from './tools.js';

describe('flatToolName', () => {
  it('合法的名字原样或 <ns>__<name>', () => {
    expect(flatToolName('exec_command')).toBe('exec_command');
    expect(flatToolName('spawn_agent', 'multi_agent_v1')).toBe('multi_agent_v1__spawn_agent');
  });

  it('超过 64 个字符或含非法字符：截断、换 _ 再接 8 位哈希，确定且合法', () => {
    const long = flatToolName('t'.repeat(80), 'ns');
    expect(long).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(long).toBe(flatToolName('t'.repeat(80), 'ns'));
    expect(long).not.toBe(flatToolName('t'.repeat(81), 'ns'));
    const dotted = flatToolName('read', 'mcp.fs');
    expect(dotted).toMatch(/^mcp_fs__read_[0-9a-f]{8}$/);
    // 只差非法字符的两个名字不会撞名。
    expect(flatToolName('read', 'mcp:fs')).not.toBe(dotted);
  });
});

describe('ToolNames', () => {
  it('登记后可逆；同一原工具总是同一个名字', () => {
    const names = new ToolNames();
    const a = names.flat({ kind: 'custom', name: 'apply_patch' });
    expect(names.flat({ kind: 'custom', name: 'apply_patch' })).toBe(a);
    expect(names.origin(a)).toEqual({ kind: 'custom', name: 'apply_patch' });
    expect(names.origin('nope')).toBeUndefined();
    expect(names.size).toBe(1);
  });

  it('还原：custom 解出 input，function 带回 namespace', () => {
    const names = new ToolNames();
    const patch = names.flat({ kind: 'custom', name: 'apply_patch' });
    const spawn = names.flat({
      kind: 'function',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1',
    });
    expect(
      restoreToolCall(names, { callId: 'c', name: patch, arguments: '{"input":"p"}' }),
    ).toEqual({
      type: 'custom_tool_call',
      call_id: 'c',
      name: 'apply_patch',
      input: 'p',
    });
    expect(restoreToolCall(names, { callId: 'd', name: spawn, arguments: '{}' })).toEqual({
      type: 'function_call',
      call_id: 'd',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1',
      arguments: '{}',
    });
    expect(customCallInput('{"other":1}')).toBe('{"other":1}');
  });
});
