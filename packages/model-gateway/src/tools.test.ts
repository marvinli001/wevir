import { describe, expect, it } from 'vitest';
import {
  customCallInput,
  flatToolName,
  restoreToolCall,
  ToolNames,
  writeStdinArguments,
} from './tools.js';

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

describe('writeStdinArguments', () => {
  const chars = (args: string) =>
    (JSON.parse(writeStdinArguments(args)) as { chars: string }).chars;

  it('整个 chars 都是控制键转义时换成控制字符', () => {
    expect(chars(String.raw`{"session_id":1,"chars":"\\u0003"}`)).toBe('\u0003');
    expect(chars(String.raw`{"session_id":1,"chars":"\\x03"}`)).toBe('\u0003');
    expect(chars('{"session_id":1,"chars":"^C"}')).toBe('\u0003');
    expect(chars('{"session_id":1,"chars":"^d"}')).toBe('\u0004');
    expect(chars(String.raw`{"session_id":1,"chars":"^[\\r"}`)).toBe('\u001b\r');
    expect(chars(String.raw`{"session_id":1,"chars":"\\e[A\\n"}`)).toBe(String.raw`\e[A\n`);
  });

  it('夹着普通文字、已经是控制字符或解析不了时原样', () => {
    const plain = String.raw`{"session_id":1,"chars":"echo \\u0003"}`;
    expect(writeStdinArguments(plain)).toBe(plain);
    const real = '{"session_id":1,"chars":"\\u0003"}';
    expect(writeStdinArguments(real)).toBe(real);
    expect(writeStdinArguments('{"session_id":1,"chars":"5^2"}')).toBe(
      '{"session_id":1,"chars":"5^2"}',
    );
    expect(writeStdinArguments('not json')).toBe('not json');
  });

  it('只对 Codex 的 write_stdin 生效', () => {
    const names = new ToolNames();
    const args = String.raw`{"session_id":1,"chars":"\\u0003"}`;
    const restored = restoreToolCall(names, { callId: 'c', name: 'write_stdin', arguments: args });
    expect(JSON.parse(String(restored.arguments)).chars).toBe('\u0003');
    const other = restoreToolCall(names, { callId: 'd', name: 'other_tool', arguments: args });
    expect(other.arguments).toBe(args);
  });
});
