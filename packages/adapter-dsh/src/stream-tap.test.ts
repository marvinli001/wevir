import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { dshAdapterCapabilities } from './capabilities.js';
import {
  defaultStreamTapPluginDir,
  parseStreamTapLine,
  STREAM_TAP_MAX_LINE_BYTES,
  STREAM_TAP_PACKAGE,
  StreamTapDecoder,
  type StreamTapEvent,
  type StreamTapWarning,
  streamTapEvents,
  streamTapOverlay,
} from './stream-tap.js';

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** 插件写出的一行（形状同 dsh 的 AssistantStreamFrame，见 T0.3 fixtures/stream-tap）。 */
function frameLine(frame: Record<string, unknown>, sessionId = 'ses-1'): string {
  return `${JSON.stringify({ type: 'frame', sessionId, frame: { attemptId: `${sessionId}:1`, revision: 1, ...frame } })}\n`;
}

const chunk = (index: number, payload: Record<string, unknown>) =>
  frameLine({ type: 'chunk', index, time: 1791777266733, chunk: payload });

/** 一段典型的输出：思考块 0、文本块 1，夹着 dsh 的其他 chunk 类型。 */
const SAMPLE = [
  '{"type":"ready"}\n',
  frameLine({ type: 'start', turn: 1, step: 1 }),
  chunk(0, { type: 'block-start', index: 0, blockType: 'reasoning' }),
  chunk(1, { type: 'reasoning-delta', index: 0, text: '简单介' }),
  chunk(2, { type: 'reasoning-delta', index: 0, text: '绍即可。' }),
  chunk(3, { type: 'block-end', index: 0, block: { type: 'reasoning', text: '简单介绍即可。' } }),
  chunk(4, { type: 'block-start', index: 1, blockType: 'text' }),
  chunk(5, { type: 'text-delta', index: 1, text: '西湖位于' }),
  chunk(6, { type: 'text-delta', index: 1, text: '' }),
  chunk(7, { type: 'text-delta', index: 1, text: '杭州。🌊' }),
  chunk(8, { type: 'usage', usage: { input: 1, output: 2 } }),
  chunk(9, { type: 'finish', reason: 'stop' }),
  frameLine({
    type: 'end',
    index: 10,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 },
  }),
].join('');

const EXPECTED: StreamTapEvent[] = [
  {
    type: 'assistant.delta',
    engineSessionId: 'ses-1',
    attemptId: 'ses-1:1',
    blockIndex: 0,
    kind: 'reasoning',
    text: '简单介',
  },
  {
    type: 'assistant.delta',
    engineSessionId: 'ses-1',
    attemptId: 'ses-1:1',
    blockIndex: 0,
    kind: 'reasoning',
    text: '绍即可。',
  },
  {
    type: 'assistant.delta',
    engineSessionId: 'ses-1',
    attemptId: 'ses-1:1',
    blockIndex: 1,
    kind: 'text',
    text: '西湖位于',
  },
  {
    type: 'assistant.delta',
    engineSessionId: 'ses-1',
    attemptId: 'ses-1:1',
    blockIndex: 1,
    kind: 'text',
    text: '杭州。🌊',
  },
  {
    type: 'assistant.stream_ended',
    engineSessionId: 'ses-1',
    attemptId: 'ses-1:1',
    outcome: 'committed',
  },
];

function decoder() {
  const events: StreamTapEvent[] = [];
  const warnings: StreamTapWarning[] = [];
  let ready = 0;
  const d = new StreamTapDecoder({
    onEvent: (event) => events.push(event),
    onReady: () => {
      ready += 1;
    },
    onWarning: (warning) => warnings.push(warning),
  });
  return {
    d,
    events,
    warnings,
    get ready() {
      return ready;
    },
  };
}

describe('StreamTapDecoder：NDJSON 解析', () => {
  it('逐行解析：ready、推理与文本增量分开、end；其余 chunk 与空文本不产出事件', () => {
    const t = decoder();
    t.d.push(Buffer.from(SAMPLE));
    expect(t.ready).toBe(1);
    expect(t.events).toEqual(EXPECTED);
    expect(t.warnings).toEqual([]);
  });

  it('行可以在任意字节处被切开，包括多字节字符中间', () => {
    const bytes = Buffer.from(SAMPLE);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const t = decoder();
      t.d.push(bytes.subarray(0, cut));
      t.d.push(bytes.subarray(cut));
      expect(t.events, `在第 ${cut} 字节切开`).toEqual(EXPECTED);
      expect(t.warnings).toEqual([]);
    }
    const t = decoder();
    for (const byte of bytes) t.d.push(Uint8Array.of(byte));
    expect(t.events).toEqual(EXPECTED);
  });

  it('畸形行告警后跳过，前后的行照常解析', () => {
    const bad = [
      'not json',
      '[1,2]',
      '{"type":"hello"}',
      '{"type":"frame","frame":{"type":"start","attemptId":"x"}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"start"}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"pause","attemptId":"x"}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"chunk","attemptId":"x"}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"chunk","attemptId":"x","chunk":{"type":"text-delta","index":0}}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"chunk","attemptId":"x","chunk":{"type":"text-delta","index":-1,"text":"a"}}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"end","attemptId":"x","outcome":{"kind":"lost"}}}',
      '{"type":"frame","sessionId":"ses-1","frame":{"type":"chunk","attemptId":"x","chunk":{"type":"text-delta","index":0,"text":"a"}}', // 缺右括号
    ];
    const t = decoder();
    const good = chunk(1, { type: 'text-delta', index: 1, text: 'ok' });
    t.d.push(Buffer.from([good, ...bad.map((line) => `${line}\n`), good].join('')));
    // 不是合法 UTF-8 的一行
    t.d.push(Buffer.from([0xff, 0xfe, 0x0a]));
    t.d.push(Buffer.from(good));

    expect(t.events.map((e) => e.type === 'assistant.delta' && e.text)).toEqual(['ok', 'ok', 'ok']);
    expect(t.warnings).toHaveLength(bad.length + 1);
    expect(t.warnings.every((w) => w.kind === 'malformed')).toBe(true);
    expect(t.warnings[0]).toMatchObject({
      line: 'not json',
      message: expect.stringMatching(/无法解析/),
    });
    expect(t.warnings[5]?.message).toMatch(/未知帧类型 "pause"/);
    expect(t.warnings.at(-1)?.message).toMatch(/UTF-8/);
  });

  it('容忍空行与 \\r\\n 行尾', () => {
    const t = decoder();
    t.d.push(Buffer.from(`\n\r\n  \n${SAMPLE.replaceAll('\n', '\r\n')}`));
    expect(t.events).toEqual(EXPECTED);
    expect(t.warnings).toEqual([]);
  });

  it('超长行丢弃并告警，下一行起恢复正常', () => {
    const t = decoder();
    t.d.push(Buffer.alloc(STREAM_TAP_MAX_LINE_BYTES, 'x'.charCodeAt(0)));
    t.d.push(Buffer.from('xxxx'));
    t.d.push(Buffer.from(`yyy\n${SAMPLE}`));
    expect(t.warnings).toEqual([expect.objectContaining({ kind: 'too_long' })]);
    expect(t.warnings[0]?.line).toHaveLength(200);
    expect(t.events).toEqual(EXPECTED);
  });

  it('end：没有换行的半行告警 truncated 并丢弃，之后从干净状态继续', () => {
    const t = decoder();
    const line = chunk(1, { type: 'text-delta', index: 1, text: '半行' });
    t.d.push(Buffer.from(line.slice(0, -10)));
    t.d.end();
    expect(t.events).toEqual([]);
    expect(t.warnings).toEqual([expect.objectContaining({ kind: 'truncated' })]);
    t.d.push(Buffer.from(SAMPLE));
    t.d.end();
    expect(t.events).toEqual(EXPECTED);
    expect(t.warnings).toHaveLength(1);
  });

  it('abandoned 的 end 帧；会话 ID 取自记录', () => {
    const record = parseStreamTapLine(
      frameLine({ type: 'end', index: 3, outcome: { kind: 'abandoned' } }, 'ses-2').trim(),
    );
    expect(streamTapEvents(record)).toEqual([
      {
        type: 'assistant.stream_ended',
        engineSessionId: 'ses-2',
        attemptId: 'ses-2:1',
        outcome: 'abandoned',
      },
    ]);
  });
});

describe('stream-tap 插件（../stream-tap，在 dsh 进程里运行）', () => {
  const dir = defaultStreamTapPluginDir();

  interface FakeCtx {
    listeners: Map<string, (payload: unknown) => void>;
    warnings: string[];
    logger: { warn: (message: string) => void };
    on: (name: string, listener: (payload: unknown) => void) => () => void;
  }

  function fakeCtx(): FakeCtx {
    const ctx: FakeCtx = {
      listeners: new Map(),
      warnings: [],
      logger: { warn: (message) => ctx.warnings.push(message) },
      on: (name, listener) => {
        ctx.listeners.set(name, listener);
        return () => ctx.listeners.delete(name);
      },
    };
    return ctx;
  }

  async function loadPlugin(): Promise<{ name: string; apply: (ctx: FakeCtx) => void }> {
    return import(pathToFileURL(join(dir, 'index.js')).href);
  }

  function withStreamFd(value: string | undefined): void {
    const saved = process.env.WEVIR_STREAM_FD;
    if (value === undefined) delete process.env.WEVIR_STREAM_FD;
    else process.env.WEVIR_STREAM_FD = value;
    cleanups.push(() => {
      if (saved === undefined) delete process.env.WEVIR_STREAM_FD;
      else process.env.WEVIR_STREAM_FD = saved;
    });
  }

  it('包名、overlay 里的插件行与常量一致；插件源码不 import @deepseek-ai/*、不写 stdout', async () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: STREAM_TAP_PACKAGE, type: 'module', main: 'index.js' });
    expect(manifest).not.toHaveProperty('dependencies');
    const overlay = readFileSync(streamTapOverlay(dir), 'utf8');
    expect(overlay).toContain(`name: '${STREAM_TAP_PACKAGE}'`);
    expect(overlay).toContain('- insert:');

    const source = readFileSync(join(dir, 'index.js'), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['node:fs']);
    expect(source).not.toMatch(/process\.stdout|console\./);
    const plugin = await loadPlugin();
    expect(plugin.name).toBe('wevir-stream-tap');
    expect(Object.keys(plugin).sort()).toEqual(['apply', 'name']);
  });

  it('apply：先写 ready，再把每个 agent/assistant-stream 帧连同会话 ID 写成一行', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-stream-tap-')));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const file = join(tmp, 'fd.ndjson');
    const fd = openSync(file, 'w');
    cleanups.push(() => closeSync(fd));
    withStreamFd(String(fd));

    const ctx = fakeCtx();
    (await loadPlugin()).apply(ctx);
    const listener = ctx.listeners.get('agent/assistant-stream');
    expect(listener).toBeDefined();
    const frame = {
      type: 'chunk',
      attemptId: 'ses-1:1',
      index: 0,
      chunk: { type: 'text-delta', index: 1, text: '湖' },
    };
    listener?.({ agent: { session: { id: 'ses-1' } }, frame });
    // 监听器里的异常不能冒到 dsh 的 agent loop：没有 session 的 agent 只告警
    expect(() => listener?.({ agent: {}, frame })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(readFileSync(file, 'utf8')).toBe(
      `{"type":"ready"}\n${JSON.stringify({ type: 'frame', sessionId: 'ses-1', frame })}\n`,
    );
    expect(ctx.warnings).toEqual([expect.stringMatching(/转发帧失败/)]);
  });

  it('WEVIR_STREAM_FD 无效时只告警，不注册监听器', async () => {
    const plugin = await loadPlugin();
    for (const value of [undefined, '', '1', 'abc']) {
      withStreamFd(value);
      const ctx = fakeCtx();
      plugin.apply(ctx);
      expect(ctx.listeners.size).toBe(0);
      expect(ctx.warnings).toEqual([expect.stringMatching(/WEVIR_STREAM_FD 无效/)]);
    }
  });
});

describe('dshAdapterCapabilities', () => {
  it('只有旁路生效时声明 incrementalStream，其余能力不随旁路变化', () => {
    expect(dshAdapterCapabilities('active').incrementalStream).toBe(true);
    for (const state of ['off', 'unavailable', 'waiting'] as const) {
      const caps = dshAdapterCapabilities(state);
      expect(caps.incrementalStream).toBe(false);
      expect(caps).toEqual({ ...dshAdapterCapabilities('active'), incrementalStream: false });
    }
  });
});
