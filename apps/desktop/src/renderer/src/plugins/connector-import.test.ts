import { describe, expect, it } from 'vitest';
import {
  normalizeConnectorName,
  parseConnectorJson,
  withExisting,
  withoutAdded,
} from './connector-import';

const parse = (value: unknown) => parseConnectorJson(JSON.stringify(value));

describe('normalizeConnectorName', () => {
  it('小写、不合规的字符换成 -、首尾去掉，转不出来是空串', () => {
    expect(normalizeConnectorName('GitHub')).toBe('github');
    expect(normalizeConnectorName('  My Server (prod)  ')).toBe('my-server-prod');
    expect(normalizeConnectorName('a.b/c')).toBe('a-b-c');
    expect(normalizeConnectorName('keep_this-name')).toBe('keep_this-name');
    expect(normalizeConnectorName('文件系统')).toBe('');
    expect(normalizeConnectorName('x'.repeat(200))).toHaveLength(128);
  });
});

describe('parseConnectorJson：外壳', () => {
  it('空白文本什么都没有，不是 JSON 是 syntax', () => {
    expect(parseConnectorJson('  \n')).toEqual({ entries: [], issues: [] });
    expect(parseConnectorJson('{ nope').issues).toEqual([{ reason: 'syntax' }]);
  });

  it('认 mcpServers（Claude、Cursor）、servers（VS Code）与没有外壳的服务表', () => {
    const server = { command: 'npx', args: ['-y', 'pkg'] };
    for (const data of [{ mcpServers: { a: server } }, { servers: { a: server } }, { a: server }]) {
      const result = parse(data);
      expect(result.issues).toEqual([]);
      expect(result.entries).toEqual([
        {
          name: 'a',
          source: 'a',
          config: { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
          ignored: [],
        },
      ]);
    }
  });

  it('不是对象、找不到服务表、服务表是空的', () => {
    expect(parse([]).issues).toEqual([{ reason: 'shape' }]);
    expect(parse('x').issues).toEqual([{ reason: 'shape' }]);
    expect(parse({ hello: 'world' }).issues).toEqual([{ reason: 'shape' }]);
    expect(parse({ command: 'npx' }).issues).toEqual([{ reason: 'shape' }]);
    expect(parse({ mcpServers: [] }).issues).toEqual([{ reason: 'shape' }]);
    expect(parse({ mcpServers: {} }).issues).toEqual([{ reason: 'empty' }]);
  });

  it('带 BOM 的文本也能读', () => {
    const result = parseConnectorJson(`﻿${JSON.stringify({ mcpServers: { a: { command: 'x' } } })}`);
    expect(result.entries).toHaveLength(1);
  });
});

describe('parseConnectorJson：服务', () => {
  it('一次导入多个，命令与地址混合', () => {
    const result = parse({
      mcpServers: {
        fs: {
          command: 'npx',
          args: ['-y', '@mcp/fs', '/tmp'],
          env: { A: 'a', N: 1, B: true },
          cwd: '/w',
        },
        Remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        typed: { type: 'http', url: 'https://example.com/mcp' },
        explicit: { type: 'stdio', command: 'node', args: [1, 'a'] },
      },
    });
    expect(result.issues).toEqual([]);
    expect(result.entries.map((entry) => [entry.name, entry.source, entry.config])).toEqual([
      [
        'fs',
        'fs',
        {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@mcp/fs', '/tmp'],
          env: { A: 'a', N: '1', B: 'true' },
          cwd: '/w',
        },
      ],
      [
        'remote',
        'Remote',
        {
          transport: 'http',
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      ],
      ['typed', 'typed', { transport: 'http', url: 'https://example.com/mcp' }],
      ['explicit', 'explicit', { transport: 'stdio', command: 'node', args: ['1', 'a'] }],
    ]);
  });

  it('Codex 写法的 http_headers、tool_timeout_sec，disabled 与 enabled 换成 enabled', () => {
    const result = parse({
      mcpServers: {
        a: { url: 'https://x.test/mcp', http_headers: { K: 'v' }, tool_timeout_sec: 30 },
        b: { command: 'x', disabled: true },
        c: { command: 'x', enabled: false },
      },
    });
    expect(result.entries.map((entry) => entry.config)).toEqual([
      { transport: 'http', url: 'https://x.test/mcp', headers: { K: 'v' }, toolTimeoutSec: 30 },
      { transport: 'stdio', command: 'x', enabled: false },
      { transport: 'stdio', command: 'x', enabled: false },
    ]);
  });

  it('认不出的字段不导入，记在 ignored 里', () => {
    const result = parse({
      mcpServers: { a: { command: 'x', timeout: 600, autoApprove: ['t'], alwaysAllow: [] } },
    });
    expect(result.entries[0]?.ignored).toEqual(['timeout', 'autoApprove', 'alwaysAllow']);
  });

  it('SSE 不支持，type 认不出或没有 command / url 是 transport', () => {
    const result = parse({
      mcpServers: {
        old: { type: 'sse', url: 'https://x.test/sse' },
        weird: { type: 'websocket', url: 'ws://x' },
        empty: { args: ['x'] },
      },
    });
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([
      { reason: 'sse', name: 'old' },
      { reason: 'transport', name: 'weird', detail: 'websocket' },
      { reason: 'transport', name: 'empty' },
    ]);
  });

  it('名字转不出、以 wevir 开头、转换后重名都是问题', () => {
    const result = parse({
      mcpServers: {
        文件: { command: 'x' },
        Wevir_tools: { command: 'x' },
        'My Tool': { command: 'x' },
        'my-tool': { command: 'y' },
      },
    });
    expect(result.entries.map((entry) => entry.name)).toEqual(['my-tool']);
    expect(result.issues).toEqual([
      { reason: 'name', name: '文件' },
      { reason: 'reserved', name: 'Wevir_tools' },
      { reason: 'duplicate', name: 'my-tool' },
    ]);
  });

  it('字段类型不对或协议校验不过是 invalid，带出问题的字段', () => {
    const result = parse({
      mcpServers: {
        notObject: 'x',
        badArgs: { command: 'x', args: 'a b' },
        badEnv: { command: 'x', env: { A: null } },
        badHeaders: { url: 'https://x.test', headers: ['a'] },
        noCommand: { type: 'stdio' },
        badUrl: { url: 'ftp://x.test' },
        credentials: { url: 'https://user:pw@x.test/mcp' },
        notAUrl: { url: 'not a url' },
      },
    });
    expect(result.entries).toEqual([]);
    expect(result.issues).toEqual([
      { reason: 'invalid', name: 'notObject' },
      { reason: 'invalid', name: 'badArgs', detail: 'args' },
      { reason: 'invalid', name: 'badEnv', detail: 'env' },
      { reason: 'invalid', name: 'badHeaders', detail: 'headers' },
      { reason: 'invalid', name: 'noCommand', detail: 'command' },
      { reason: 'invalid', name: 'badUrl', detail: 'url' },
      { reason: 'invalid', name: 'credentials', detail: 'url' },
      { reason: 'invalid', name: 'notAUrl', detail: 'url' },
    ]);
  });
});

describe('withExisting', () => {
  it('与已有连接器重名的记成问题，条目留着', () => {
    const result = withExisting(
      parse({ mcpServers: { Taken: { command: 'x' }, free: { command: 'y' } } }),
      new Set(['taken']),
    );
    expect(result.entries.map((entry) => entry.name)).toEqual(['taken', 'free']);
    expect(result.issues).toEqual([{ reason: 'exists', name: 'Taken' }]);
  });
});

describe('withoutAdded', () => {
  it('导入一半失败后，已成功的条目与它们的“已存在”问题去掉，失败的留着重试', () => {
    const parsed = parse({ mcpServers: { A: { command: 'x' }, b: { command: 'y' } } });
    // 添加了 A 之后，已有的名字里就有它了。
    const result = withExisting(parsed, new Set(['a']));
    expect(result.issues).toEqual([{ reason: 'exists', name: 'A' }]);
    const retry = withoutAdded(result, new Set(['a']));
    expect(retry.entries.map((entry) => entry.name)).toEqual(['b']);
    expect(retry.issues).toEqual([]);
  });

  it('别的问题照留', () => {
    const parsed = parse({
      mcpServers: { a: { command: 'x' }, bad: { type: 'sse', url: 'https://x.test' } },
    });
    expect(withoutAdded(parsed, new Set(['a'])).issues).toEqual([{ reason: 'sse', name: 'bad' }]);
  });
});
