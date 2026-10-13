// DshAdapter 恢复会话的真实 dsh 集成测试（T3.5）：
// - Host 重启：一个适配器建会话、对话后释放，另一个适配器（同一 DSH_HOME，新的 dsh 进程，不认识这个会话）resume
//   之后追问，模型收到的请求里有之前的对话（T0.3 §8 的 H 场景）。mock Provider 不需要 Key；设了
//   WEVIR_TEST_API_KEY 时另用真实模型跑一遍，看模型能引用之前的内容。
// - 引擎会话丢失：会话日志被删除、由更新的 dsh 写入、损坏时报 session_lost 与原因；dsh 的原文与
//   test-fixtures/acp/errors/resume-*.json 逐字比对（会话 ID、路径换成占位符），fake-dsh 回放的就是这些样本。
//   dsh 改了措辞时这里先失败：设 WEVIR_RECORD_FIXTURES=1 重跑会改写样本，再按新措辞改 resume-error.ts 的规则表。
// - cwd 不一致（含目录已不存在）报 session_unavailable。
// resume 本身不请求模型，丢失与 cwd 的用例只为建会话选路由才需要 mock Provider 的 overlay。

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import {
  type AdapterError,
  type AgentEvent,
  isAdapterError,
  isTurnTerminal,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import { DSH_VERSION } from './paths.js';
import { ACP_FIXTURES, readFixture } from './test-fixtures/acp-fixtures.js';
import {
  MOCK_KEY,
  MOCK_KEY_ENV,
  MOCK_MODEL,
  type MockRequest,
  startMockModel,
  textOf,
  writeMockOverlay,
} from './test-fixtures/mock-model.js';
import { type ModelSetup, REAL_KEY, realModelSetup } from './test-fixtures/real-model.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-resume-it-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function newAdapter(home: string, setup: ModelSetup): DshAdapter {
  const adapter = new DshAdapter({
    home,
    patches: setup.patches,
    env: setup.env,
    streamTap: false,
    logger: { warn: () => {} },
  });
  cleanups.push(() => adapter.dispose());
  return adapter;
}

/** 发一条提示，读到回合结束，返回本回合的事件。 */
async function turn(adapter: DshAdapter, id: string, text: string): Promise<AgentEvent[]> {
  const events = adapter.subscribe(id)[Symbol.asyncIterator]();
  await adapter.send(id, { content: [{ type: 'text', text }] });
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error('订阅在回合结束前结束');
    out.push(value);
    if (isTurnTerminal(value)) break;
  }
  await events.return?.();
  return out;
}

const reply = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === 'assistant.message')
    .map((e) => e.text)
    .join('');

async function resumeError(promise: Promise<unknown>): Promise<AdapterError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isAdapterError(error)) throw new Error(`应以 AdapterError 失败：${String(error)}`);
  return error;
}

// ── Host 重启后恢复 ───────────────────────────────────────────────────────────

const CODE = '青石桥-4721';
const TELL = `[wevir:RECALL] 我的暗号是 ${CODE}。记住它，只回复“好的”。`;
const ASK = '[wevir:RECALL] 我的暗号是什么？只回复暗号本身。';

/** mock 模型只看请求作答：告知暗号就回“好的”，追问时从请求里的历史消息找暗号。 */
function recallScript(requests: MockRequest[]) {
  return (request: MockRequest) => {
    requests.push(request);
    const users = request.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
    const last = users.findLast((text) => text.includes('[wevir:RECALL]')) ?? '';
    if (last.includes('记住它')) return { text: ['好的'] };
    const told = users.map((text) => /我的暗号是 (\S+?)。/.exec(text)?.[1]).find(Boolean);
    return { text: [told ?? '不知道'] };
  };
}

async function mockSetup(script: (request: MockRequest) => { text: string[] }) {
  const model = await startMockModel(script);
  cleanups.push(() => model.close());
  return {
    patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
    env: { [MOCK_KEY_ENV]: MOCK_KEY },
    providerId: 'wevir-test',
    modelId: MOCK_MODEL,
  } satisfies ModelSetup;
}

/** 建会话 → 告知暗号 → 释放适配器（Host 重启） → 新适配器 resume → 追问。返回追问的回复。 */
async function restartAndAsk(setup: ModelSetup) {
  const home = tempDir('home');
  const config: SessionConfig = {
    cwd: tempDir('ws'),
    providerId: setup.providerId,
    modelId: setup.modelId,
  };
  const first = newAdapter(home, setup);
  const { engineSessionId } = await first.createSession(config);
  const told = await turn(first, engineSessionId, TELL);
  expect(told.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  await first.dispose();

  const second = newAdapter(home, setup);
  const resumed = await second.resumeSession(engineSessionId, config);
  expect(resumed).toMatchObject({
    engineSessionId,
    engineVersion: DSH_VERSION,
    modelId: setup.modelId,
  });
  // 已挂上时直接成功，不再问 dsh（dsh 会报 already active）。
  await expect(second.resumeSession(engineSessionId, config)).resolves.toMatchObject({
    engineSessionId,
  });
  const asked = await turn(second, engineSessionId, ASK);
  expect(asked.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  return reply(asked);
}

describe('DshAdapter 恢复会话（真实 dsh + mock Provider）', () => {
  it('Host 重启：新的 dsh 进程 resume 之后，模型收到的请求里有之前的对话', async () => {
    const requests: MockRequest[] = [];
    const answer = await restartAndAsk(await mockSetup(recallScript(requests)));
    expect(answer).toBe(CODE);
    // resume 后第一个请求带着之前的提示与回复（T0.3 §8：模型可见的上下文完整）。
    const after = requests.at(-1)?.messages.map((m) => `${m.role}:${textOf(m.content)}`) ?? [];
    expect(after.some((line) => line.startsWith('user:') && line.includes(TELL))).toBe(true);
    expect(after).toContain('assistant:好的');
  }, 60_000);

  it('同一进程里 close 之后 resume：照常对话', async () => {
    const requests: MockRequest[] = [];
    const setup = await mockSetup(recallScript(requests));
    const adapter = newAdapter(tempDir('home'), setup);
    const config: SessionConfig = {
      cwd: tempDir('ws'),
      providerId: setup.providerId,
      modelId: setup.modelId,
    };
    const { engineSessionId } = await adapter.createSession(config);
    await turn(adapter, engineSessionId, TELL);
    await adapter.close(engineSessionId);
    const resumed = await adapter.resumeSession(engineSessionId, config);
    expect(resumed).toMatchObject({ engineSessionId, modelId: MOCK_MODEL });
    expect(reply(await turn(adapter, engineSessionId, ASK))).toBe(CODE);
  }, 60_000);
});

describe.skipIf(REAL_KEY === undefined)('DshAdapter 恢复会话（真实模型）', () => {
  it('Host 重启后 resume，追问能引用之前告知的暗号', async () => {
    const answer = await restartAndAsk(realModelSetup(tempDir('overlay'), REAL_KEY as string));
    expect(answer).toContain(CODE);
  }, 180_000);
});

// ── 引擎会话丢失与 cwd 不一致 ──────────────────────────────────────────────────

const RECORD = process.env.WEVIR_RECORD_FIXTURES === '1';

/** 会话日志 `<DSH_HOME>/sessions/<cwd 编码>/<sessionId>/session.v<N>.jsonl.zstd`（T0.3 §8）。 */
function sessionLog(dshHome: string, sessionId: string): string {
  const root = join(dshHome, 'sessions');
  for (const dir of readdirSync(root)) {
    const sessionDir = join(root, dir, sessionId);
    let names: string[];
    try {
      names = readdirSync(sessionDir);
    } catch {
      continue;
    }
    const log = names.find((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name));
    if (log !== undefined) return join(sessionDir, log);
  }
  throw new Error(`找不到会话 ${sessionId} 的日志`);
}

/** dsh 把日志写成一串 Zstandard 帧，第一帧只有日志头一行；最后一帧可能没有结束标记。 */
const decompress = (data: Buffer) =>
  zstdDecompressSync(data, { finishFlush: constants.ZSTD_e_flush }).toString('utf8');
const frame = (text: string) =>
  zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });

interface RecordedError {
  recordedBy: string;
  error: { name: string; message: string; code: number; data?: unknown };
}

/**
 * 样本里的占位符：会话 ID、DSH_HOME、会话日志的 cwd 编码目录、临时目录。逐个字符串替换（JSON 文本里
 * Windows 路径的反斜杠被转义，整段匹配不上），占位符后面的路径分隔符统一成 /，样本与平台无关。
 */
function normalized(value: unknown, sessionId: string, dshHome: string, tmp: string): unknown {
  const text = JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'string'
      ? v
          .replaceAll(sessionId, '<SESSION_ID>')
          .replaceAll(dshHome, '<DSH_HOME>')
          .replaceAll(tmp, '<TMP>')
          .replace(/<(DSH_HOME|TMP)>[^\s)'"]*/g, (path) => path.replaceAll('\\', '/'))
          .replace(/<DSH_HOME>\/sessions\/[^/]+\//g, '<DSH_HOME>/sessions/<CWD>/')
      : v,
  );
  return JSON.parse(text);
}

async function lostSetup() {
  const setup = await mockSetup(() => ({ text: ['好的'] }));
  const home = tempDir('home');
  const adapter = newAdapter(home, setup);
  const config: SessionConfig = {
    cwd: tempDir('ws'),
    providerId: setup.providerId,
    modelId: setup.modelId,
  };
  const { engineSessionId } = await adapter.createSession(config);
  await adapter.close(engineSessionId);
  const dshHome = adapter.process.paths.dshHome;
  return { adapter, config, engineSessionId, dshHome, log: sessionLog(dshHome, engineSessionId) };
}

const LOST_CASES = [
  {
    name: 'resume-not-resumable.json',
    title: '会话日志被删除（DSH_HOME 被清理）：not_found',
    reason: 'not_found',
    recordedBy: '会话关闭后删掉它的日志目录',
    tamper: (log: string) => rmSync(join(log, '..'), { recursive: true, force: true }),
  },
  {
    name: 'resume-format-newer.json',
    title: '日志由更新的 dsh 写入（格式 v5）：incompatible',
    reason: 'incompatible',
    recordedBy: '会话关闭后把日志头的 version 改为 5、文件名改为 session.v5.jsonl.zstd',
    tamper: (log: string) => {
      const [header = '', ...rest] = decompress(readFileSync(log)).split('\n');
      const newer = header.replace('"version":4', '"version":5');
      if (newer === header) throw new Error(`日志头里没有 "version":4：${header}`);
      writeFileSync(
        log.replace('session.v4.', 'session.v5.'),
        Buffer.concat([frame(`${newer}\n`), frame(rest.join('\n'))]),
      );
      rmSync(log);
    },
  },
  {
    name: 'resume-log-corrupt.json',
    title: '日志损坏（末尾有一条写坏的记录）：corrupted',
    reason: 'corrupted',
    recordedBy: '会话关闭后在日志末尾追加一个只含半条 JSON 记录的完整帧',
    tamper: (log: string) =>
      writeFileSync(log, Buffer.concat([readFileSync(log), frame('{"seq":"oops"\n')])),
  },
] as const;

describe('DshAdapter 恢复不了的会话（真实 dsh）', () => {
  for (const c of LOST_CASES) {
    it(`${c.title}，原文与样本 ${c.name} 一致`, async () => {
      const t = await lostSetup();
      c.tamper(t.log);
      const error = await resumeError(t.adapter.resumeSession(t.engineSessionId, t.config));
      expect(error.code).toBe('session_lost');
      expect(error.lostReason).toBe(c.reason);
      expect(error.message).toContain(t.engineSessionId);
      const { name, code, message, data } = error.cause as RequestErrorLike;
      const raw = { name, message, code, ...(data !== undefined && { data }) };
      const actual = normalized(raw, t.engineSessionId, t.dshHome, realpathSync(tmpdir()));
      if (RECORD) {
        const recordedBy = `T3.5 dsh-adapter.resume.integration.test.ts：真实 dsh ${DSH_VERSION}，${c.recordedBy}`;
        writeFileSync(
          join(ACP_FIXTURES, 'errors', c.name),
          `${JSON.stringify({ recordedBy, error: actual }, null, 2)}\n`,
        );
      }
      expect(actual).toEqual(readFixture<RecordedError>(`errors/${c.name}`).error);
      // 会话还是恢复不了，适配器也没有把它当作挂着的会话。
      expect(() => t.adapter.subscribe(t.engineSessionId)).toThrow();
    }, 30_000);
  }

  it('cwd 不一致、目录已不存在：session_unavailable，换回原目录照常恢复', async () => {
    const t = await lostSetup();
    for (const cwd of [tempDir('other'), join(tmpdir(), 'wevir-dsh-resume-it-gone')]) {
      const error = await resumeError(
        t.adapter.resumeSession(t.engineSessionId, { ...t.config, cwd }),
      );
      expect(error.code).toBe('session_unavailable');
      expect(error.message).toContain(`session cwd does not match: ${cwd}`);
    }
    await expect(t.adapter.resumeSession(t.engineSessionId, t.config)).resolves.toMatchObject({
      engineSessionId: t.engineSessionId,
    });
  }, 30_000);
});

interface RequestErrorLike {
  name: string;
  code: number;
  message: string;
  data?: unknown;
}
