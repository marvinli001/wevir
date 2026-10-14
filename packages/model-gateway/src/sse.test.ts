import { describe, expect, it } from 'vitest';
import { SseParser, sseEvent } from './sse.js';

describe('SseParser', () => {
  it('按空行分事件；data: 后的一个空格去掉；没有空格也行；注释与 id 行忽略', () => {
    const p = new SseParser();
    expect(p.push('event: a\ndata: {"x":1}\n\n: keep-alive\n\ndata:{"y":2}\nid: 3\n\n')).toEqual([
      { event: 'a', data: '{"x":1}' },
      { data: '{"y":2}' },
    ]);
  });

  it('CRLF、跨 chunk 的行与被切开的多字节字符', () => {
    const p = new SseParser();
    const bytes = new TextEncoder().encode('data: 你好\r\n\r\n');
    const out = [...p.push(bytes.slice(0, 8)), ...p.push(bytes.slice(8))];
    expect(out).toEqual([{ data: '你好' }]);
  });

  it('同一事件的多行 data 用换行拼接；流结束时没有空行收尾的最后一个事件也交出', () => {
    const p = new SseParser();
    expect(p.push('data: a\ndata: b\n')).toEqual([]);
    expect(p.end()).toEqual([{ data: 'a\nb' }]);
    const q = new SseParser();
    expect([...q.push('data: [DONE]'), ...q.end()]).toEqual([{ data: '[DONE]' }]);
  });

  it('sseEvent 带 event 行', () => {
    expect(sseEvent({ type: 'response.created', response: { id: 'r' } })).toBe(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
    );
  });
});
