// 录事件：真实的 `opencode serve` + 本机假模型（mock-model.ts），把每个场景的事件流写成 test-fixtures/events/<场景>.jsonl，映射
// 回放与假服务器（fake-opencode.ts）都读它。平时跳过；要重录时：
//
//   WEVIR_RECORD_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN=/path/to/opencode \
//     pnpm vitest run --project adapter-opencode record-events
//
// opencode 的数据、配置、缓存都放在临时目录里（isolatedOpenCodeEnv），不碰用户自己的登录与会话；模型只有假的那个，不联网。
// 录下的路径换成占位符（RECORDED_ROOT），不留本机的用户名。

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newMessageId } from '../message-id.js';
import { permissionRules } from '../permissions.js';
import { type Event, loadOpenCodeSdk, OPENCODE_SDK_VERSION, type OpenCodeClient } from '../sdk.js';
import { type OpenCodeServerHandle, startOpenCodeServer } from '../server.js';
import type { RecordedAction } from './fake-opencode.js';
import {
  EXTRA_PROMPTS,
  isolatedOpenCodeEnv,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  type MockModel,
  startMockModel,
} from './mock-model.js';

const ENABLED = process.env.WEVIR_RECORD_OPENCODE === '1';
const BIN = process.env.WEVIR_TEST_OPENCODE_BIN ?? 'opencode';
const OUT_DIR = join(import.meta.dirname, 'events');
/** 录音里替换掉的临时目录。 */
const RECORDED_ROOT = '/tmp/wevir-opencode-record';

interface Scenario {
  name: string;
  prompt: string;
  /** 遇到 permission.asked / question.asked / 第 n 个增量时怎么做。 */
  permission?: { reply: 'once' | 'always' | 'reject'; message?: string };
  question?: string[][];
  abortAfterDeltas?: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'plain', prompt: DEFAULT_CONTRACT_PROMPTS.plain },
  { name: 'reasoning', prompt: EXTRA_PROMPTS.reasoning },
  { name: 'tool', prompt: DEFAULT_CONTRACT_PROMPTS.toolCall },
  {
    name: 'approval-accept',
    prompt: DEFAULT_CONTRACT_PROMPTS.approval,
    permission: { reply: 'once' },
  },
  {
    name: 'approval-decline',
    prompt: DEFAULT_CONTRACT_PROMPTS.approval,
    permission: { reply: 'reject', message: 'The user declined this action. Continue without it.' },
  },
  {
    name: 'approval-stop',
    prompt: DEFAULT_CONTRACT_PROMPTS.approval,
    permission: { reply: 'reject' },
  },
  { name: 'todo', prompt: EXTRA_PROMPTS.todo },
  { name: 'question', prompt: EXTRA_PROMPTS.question, question: [['Blue']] },
  { name: 'subagent', prompt: DEFAULT_CONTRACT_PROMPTS.subagent },
  {
    name: 'subagent-approval',
    prompt: DEFAULT_CONTRACT_PROMPTS.subagentApproval,
    permission: { reply: 'once' },
  },
  { name: 'slow-cancel', prompt: DEFAULT_CONTRACT_PROMPTS.slow, abortAfterDeltas: 3 },
  { name: 'fail', prompt: EXTRA_PROMPTS.fail },
];

function sessionOf(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  const part = properties.part as { sessionID?: unknown } | undefined;
  if (typeof part?.sessionID === 'string') return part.sessionID;
  const info = properties.info as { sessionID?: unknown; id?: unknown } | undefined;
  if (typeof info?.sessionID === 'string') return info.sessionID;
  return undefined;
}

function parentOf(event: Event): string | undefined {
  if (event.type !== 'session.created' && event.type !== 'session.updated') return undefined;
  return event.properties.info.parentID;
}

describe.skipIf(!ENABLED)('录 opencode 事件', { timeout: 120_000 }, () => {
  let root = '';
  let workspace = '';
  let model: MockModel;
  let server: OpenCodeServerHandle;
  let client: OpenCodeClient;
  let version = '';

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-record-')));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'hello.txt'), 'wevir fixture\n');
    model = await startMockModel();
    const sdk = await loadOpenCodeSdk();
    server = await startOpenCodeServer({
      executable: BIN,
      env: isolatedOpenCodeEnv(root, model.baseUrl),
      verify: async (url, password) =>
        (await sdk.connect({ baseUrl: url, directory: workspace, password }).health()).version,
    });
    version = server.version;
    client = sdk.connect({ baseUrl: server.url, directory: workspace, password: server.password });
    mkdirSync(OUT_DIR, { recursive: true });
  });

  afterAll(async () => {
    await server?.stop();
    await model?.close();
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const abort = new AbortController();
      const stream = await client.subscribe(abort.signal);
      const session = await client.createSession({ permission: permissionRules('on_request') });
      const tree = new Set([session.id]);
      const messageID = newMessageId();
      const lines: unknown[] = [];
      let deltas = 0;
      let sawBusy = false;
      const done = (async () => {
        for await (const event of stream) {
          const parent = parentOf(event);
          if (parent !== undefined && tree.has(parent) && event.type === 'session.created') {
            tree.add(event.properties.info.id);
          }
          const owner = sessionOf(event);
          if (owner === undefined || !tree.has(owner)) continue;
          lines.push({ event });
          if (event.type === 'session.status' && owner === session.id) {
            if (event.properties.status.type === 'busy') sawBusy = true;
            if (event.properties.status.type === 'idle' && sawBusy) return;
          }
          if (event.type === 'permission.asked' && scenario.permission !== undefined) {
            const action: RecordedAction = { type: 'permission', ...scenario.permission };
            lines.push({ action });
            await client.replyPermission(
              event.properties.id,
              scenario.permission.reply,
              scenario.permission.message,
            );
          }
          if (event.type === 'question.asked' && scenario.question !== undefined) {
            const action: RecordedAction = { type: 'question', answers: scenario.question };
            lines.push({ action });
            await client.replyQuestion(event.properties.id, scenario.question);
          }
          if (
            event.type === 'message.part.delta' &&
            scenario.abortAfterDeltas !== undefined &&
            ++deltas === scenario.abortAfterDeltas
          ) {
            const action: RecordedAction = { type: 'abort' };
            lines.push({ action });
            await client.abort(session.id);
          }
        }
      })();
      await client.promptAsync({
        sessionID: session.id,
        messageID,
        model: { providerID: MOCK_PROVIDER_ID, modelID: MOCK_MODEL_ID },
        parts: [{ type: 'text', text: scenario.prompt }],
      });
      await done;
      abort.abort();
      expect(lines.length).toBeGreaterThan(0);
      const meta = {
        _meta: {
          scenario: scenario.name,
          prompt: scenario.prompt,
          opencode: version,
          sdk: OPENCODE_SDK_VERSION,
          sessionID: session.id,
          messageID,
          recordedAt: new Date().toISOString().slice(0, 10),
        },
      };
      const scrub = (text: string) =>
        text
          .replaceAll(root, RECORDED_ROOT)
          // Session.path 是去掉开头 / 的 realpath。
          .replaceAll(root.slice(1), RECORDED_ROOT.slice(1))
          .replaceAll(homedir(), '/home/user')
          .replaceAll(model.baseUrl, 'http://127.0.0.1:0/v1');
      writeFileSync(
        join(OUT_DIR, `${scenario.name}.jsonl`),
        `${[meta, ...lines].map((line) => scrub(JSON.stringify(line))).join('\n')}\n`,
      );
    });
  }
});
