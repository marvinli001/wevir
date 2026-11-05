import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutputHub } from './output-hub.js';

const id = 'thread-1';
const output = (toolCallId: string, text: string): AgentEvent => ({
  type: 'tool.updated',
  engineSessionId: id,
  toolCallId,
  output: text,
});

/** 订阅者同步收到的事件（订阅的队列在 next() 时才交出，这里直接读 push 进去的）。 */
function received(hub: OutputHub): AgentEvent[] {
  const events: AgentEvent[] = [];
  const iterator = hub.subscribe();
  const pull = (): void => {
    void iterator.next().then((result) => {
      if (result.done) return;
      events.push(result.value);
      pull();
    });
  };
  pull();
  return events;
}

describe('OutputHub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一个工具的输出在窗口里只发第一条与最新的一条', async () => {
    const hub = new OutputHub({ windowMs: 100 });
    const events = received(hub);
    let text = '';
    for (let i = 0; i < 50; i += 1) {
      text += `line ${i}\n`;
      hub.emit(output('c1', text));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([output('c1', 'line 0\n')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([output('c1', 'line 0\n'), output('c1', text)]);
  });

  it('别的事件之前先发攒着的输出，命令结束时输出已经是最新的', async () => {
    const hub = new OutputHub({ windowMs: 100 });
    const events = received(hub);
    hub.emit(output('c1', 'a'));
    hub.emit(output('c1', 'ab'));
    hub.emit(output('c2', 'x'));
    hub.emit(output('c1', 'abc'));
    hub.emit({ type: 'tool.finished', engineSessionId: id, toolCallId: 'c1', status: 'completed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      events.map((e) => (e.type === 'tool.updated' ? `${e.toolCallId}:${e.output}` : e.type)),
    ).toEqual(['c1:a', 'c2:x', 'c1:abc', 'tool.finished']);
  });

  it('带展示或输入的 tool.updated 不合并；end 之前发掉攒着的', async () => {
    const hub = new OutputHub({ windowMs: 100 });
    const events = received(hub);
    const display = {
      type: 'tool.updated',
      engineSessionId: id,
      toolCallId: 'c1',
      display: { kind: 'shell', command: 'ls' },
      output: 'a',
    } as const;
    hub.emit(display);
    hub.emit(display);
    hub.emit(output('c2', 'x'));
    hub.emit(output('c2', 'xy'));
    hub.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([display, display, output('c2', 'x'), output('c2', 'xy')]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
