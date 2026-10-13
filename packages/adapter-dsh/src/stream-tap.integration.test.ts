// 增量流式旁路（T3.2a）的真实 dsh 集成测试：stream-tap 插件装进 Wevir 专属 DSH_HOME，模型换成本地脚本化的
// OpenAI 兼容服务（test-fixtures/mock-model.ts），不需要 Key。对照 T0.3：首个分片 85 ms，ACP 整条消息 3317 ms。

import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods, type SessionNotification } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { DshProcess, type DshProcessOptions } from './dsh-process.js';
import { dshProfileDir } from './paths.js';
import {
  defaultStreamTapPluginDir,
  isStreamTapInstalled,
  STREAM_TAP_PACKAGE,
  type StreamTapEvent,
  type StreamTapWarning,
} from './stream-tap.js';
import {
  MOCK_KEY,
  MOCK_KEY_ENV,
  type MockReply,
  startMockModel,
  writeMockOverlay,
} from './test-fixtures/mock-model.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-stream-tap-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs} ms）：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitForActive(dsh: DshProcess): Promise<true> {
  return waitFor(
    () => (dsh.streamTapState === 'active' ? true : undefined),
    2000,
    'stream-tap 插件报到',
  );
}

const REASONING = ['简单介', '绍即', '可。'];
/** 20 片、每片间隔 100 ms：整条消息约 2.3 s 后才提交（T0.3 场景 F 的缩短版）。 */
const TEXT = Array.from({ length: 20 }, (_, i) => `西湖第${i + 1}句。`);

interface Timed<T> {
  at: number;
  value: T;
}

/** 起 mock 模型和 dsh，记录旁路事件、告警与 ACP 更新的到达时间。 */
async function setup(options: {
  reply: MockReply;
  home?: string;
  streamTap?: { pluginDir?: string; readyGraceMs?: number } | false;
}) {
  const model = await startMockModel(() => options.reply);
  cleanups.push(() => model.close());
  const events: Array<Timed<StreamTapEvent>> = [];
  const warnings: StreamTapWarning[] = [];
  const updates: Array<Timed<SessionNotification>> = [];
  const dshOptions: DshProcessOptions = {
    home: options.home ?? tempDir('home'),
    patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
    env: { [MOCK_KEY_ENV]: MOCK_KEY },
    onSessionUpdate: (params) => void updates.push({ at: performance.now(), value: params }),
  };
  if (options.streamTap !== false) {
    dshOptions.streamTap = {
      ...options.streamTap,
      onEvent: (event) => events.push({ at: performance.now(), value: event }),
      onWarning: (warning) => warnings.push(warning),
    };
  }
  const dsh = new DshProcess(dshOptions);
  cleanups.push(() => dsh.dispose());
  await dsh.start();

  const prompt = async () => {
    const { sessionId } = await dsh.connection.agent.request(methods.agent.session.new, {
      cwd: tempDir('ws'),
      mcpServers: [],
    });
    const sentAt = performance.now();
    const result = await dsh.connection.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: '不要调用任何工具，介绍一下杭州西湖。' }],
    });
    const mine = updates.filter((u) => u.value.sessionId === sessionId);
    const chunks = (kind: string) =>
      mine.filter((u) => u.value.update.sessionUpdate === kind) as Array<
        Timed<SessionNotification & { update: { content: { text: string } } }>
      >;
    return {
      sessionId,
      sentAt,
      stopReason: result.stopReason,
      messages: chunks('agent_message_chunk'),
      thoughts: chunks('agent_thought_chunk'),
    };
  };
  return { dsh, events, warnings, prompt };
}

function deltaText(events: Array<Timed<StreamTapEvent>>, kind: 'text' | 'reasoning'): string {
  return events
    .map((e) => e.value)
    .filter((e) => e.type === 'assistant.delta' && e.kind === kind)
    .map((e) => (e.type === 'assistant.delta' ? e.text : ''))
    .join('');
}

describe('stream-tap 旁路（真实 dsh + mock Provider）', () => {
  it('首个增量明显早于 ACP 的整条消息；增量拼起来与已提交消息一致', async () => {
    const t = await setup({ reply: { reasoning: REASONING, text: TEXT, delayMs: 100 } });
    const { dsh } = t;

    // 首次启动用 dsh plugin add link: 装进 acp profile，插件在启动时报到（ready 与 initialize 的响应
    // 走两条管道，先后不定）
    await waitForActive(dsh);
    const manifest = JSON.parse(
      readFileSync(join(dshProfileDir(dsh.paths), 'package.json'), 'utf8'),
    );
    const pluginDir = realpathSync(defaultStreamTapPluginDir());
    expect(manifest.dependencies).toEqual({ [STREAM_TAP_PACKAGE]: `link:${pluginDir}` });
    expect(isStreamTapInstalled(dsh.paths, pluginDir)).toBe(true);

    const turn = await t.prompt();
    expect(turn.stopReason).toBe('end_turn');
    // ACP 只有一条已提交消息、一条思考
    expect(turn.messages).toHaveLength(1);
    expect(turn.thoughts).toHaveLength(1);
    const message = turn.messages[0] as (typeof turn.messages)[number];
    const thought = turn.thoughts[0] as (typeof turn.thoughts)[number];

    // committed 的 end 帧在 dsh 提交消息之后发出，可能晚于 prompt 的响应
    const ended = await waitFor(
      () => t.events.find((e) => e.value.type === 'assistant.stream_ended')?.value,
      3000,
      'assistant.stream_ended',
    );
    const deltas = t.events.filter((e) => e.value.type === 'assistant.delta');
    expect(new Set(t.events.map((e) => e.value.engineSessionId))).toEqual(
      new Set([turn.sessionId]),
    );
    expect(ended).toMatchObject({ outcome: 'committed' });
    expect(new Set(t.events.map((e) => e.value.attemptId))).toEqual(new Set([ended.attemptId]));
    expect(deltaText(t.events, 'text')).toBe(message.value.update.content.text);
    expect(deltaText(t.events, 'text')).toBe(TEXT.join(''));
    expect(deltaText(t.events, 'reasoning')).toBe(thought.value.update.content.text);
    expect(deltas.length).toBeGreaterThanOrEqual(REASONING.length + TEXT.length);
    expect(t.warnings).toEqual([]);

    const firstDeltaMs = (deltas[0] as Timed<StreamTapEvent>).at - turn.sentAt;
    const firstTextMs =
      (deltas.find((e) => e.value.type === 'assistant.delta' && e.value.kind === 'text')?.at ?? 0) -
      turn.sentAt;
    const acpMessageMs = message.at - turn.sentAt;
    expect(acpMessageMs - firstDeltaMs).toBeGreaterThan(1000);
    expect(acpMessageMs - firstTextMs).toBeGreaterThan(1000);
    console.info(
      `[T3.2a] 首个增量 ${firstDeltaMs.toFixed(0)} ms（首个文本增量 ${firstTextMs.toFixed(0)} ms），` +
        `ACP 整条消息 ${acpMessageMs.toFixed(0)} ms；增量 ${deltas.length} 个`,
    );
  }, 30_000);

  it('去掉插件：不开 fd 3，会话照常完成，只有 ACP 的已提交消息', async () => {
    const t = await setup({
      reply: { reasoning: REASONING, text: TEXT, delayMs: 5 },
      streamTap: false,
    });
    expect(t.dsh.streamTapState).toBe('off');
    const turn = await t.prompt();
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.messages.map((m) => m.value.update.content.text)).toEqual([TEXT.join('')]);
    expect(t.events).toEqual([]);
  }, 30_000);

  it('插件加载失败：dsh 照常启动，告警 not_loaded，会话照常完成；插件目录换回来后重新链接', async () => {
    // 一份 import 时就抛错的插件：dsh 只告警 “entry did not activate”，其余插件照常启动
    const broken = join(tempDir('plugin'), 'stream-tap');
    cpSync(defaultStreamTapPluginDir(), broken, { recursive: true });
    writeFileSync(join(broken, 'index.js'), "throw new Error('wevir test: broken plugin');\n");
    const home = tempDir('home');
    const t = await setup({
      home,
      reply: { text: TEXT, delayMs: 5 },
      streamTap: { pluginDir: broken, readyGraceMs: 500 },
    });
    expect(isStreamTapInstalled(t.dsh.paths, broken)).toBe(true);
    const warning = await waitFor(
      () => t.warnings.find((w) => w.kind === 'not_loaded'),
      3000,
      'not_loaded 告警',
    );
    expect(warning.message).toMatch(/wevir-stream-tap/);
    expect(t.dsh.streamTapState).toBe('unavailable');
    const turn = await t.prompt();
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.messages.map((m) => m.value.update.content.text)).toEqual([TEXT.join('')]);
    expect(t.events).toEqual([]);
    await t.dsh.dispose();

    // 同一个 DSH_HOME 换回正常的插件目录（相当于应用升级或搬家）：重新 link，插件报到
    const again = await setup({ home, reply: { text: TEXT, delayMs: 5 } });
    await waitForActive(again.dsh);
    expect(isStreamTapInstalled(again.dsh.paths, defaultStreamTapPluginDir())).toBe(true);
    expect(again.warnings).toEqual([]);
  }, 30_000);
});
