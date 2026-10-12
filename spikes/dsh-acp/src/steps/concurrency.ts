// 步骤 7（需要 Key 的部分）：单个 dsh 进程同时跑 3 个会话的提示，检查结果与 update 不串线。

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import {
  initialize,
  prompt,
  saveFixture,
  saveTranscript,
  startAcp,
  summarizeUpdates,
} from '../acp.ts';
import { makeWorkspace, target } from '../env.ts';
import { writeProviderOverlay } from '../overlays.ts';
import { expect } from '../report.ts';
import { prompts } from '../scenarios.ts';

const STEP = 'concurrency';

export async function concurrency(): Promise<void> {
  const kind = target().kind;
  console.log(`\n▶ 单进程 3 会话并发（${kind}）`);
  const run = startAcp({ label: 'concurrency', overlays: [writeProviderOverlay()] });
  await initialize(run);
  const tokens = ['alpha-17', 'bravo-42', 'charlie-93'];
  const sessions = await Promise.all(
    tokens.map(async (token) => {
      const cwd = makeWorkspace(`conc-${token}`);
      writeFileSync(join(cwd, 'token.txt'), `${token}\n`);
      const s = await run.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
      return { token, cwd, sessionId: s.sessionId };
    }),
  );
  const t0 = run.now();
  const outcomes = await Promise.all(sessions.map((s) => prompt(run, s.sessionId, prompts.token)));
  const wallMs = run.now() - t0;
  const rows = outcomes.map((o, i) => {
    const s = sessions[i];
    const text = summarizeUpdates(o.updates).assistantText.trim();
    return {
      expected: s?.token,
      text,
      stopReason: o.response?.stopReason,
      durationMs: o.settledAt - o.sentAt,
      ok:
        s !== undefined &&
        text.includes(s.token) &&
        tokens.every((t) => t === s.token || !text.includes(t)),
    };
  });
  // 每条 update 都带 sessionId，且只出现在自己的会话里
  const known = new Set(sessions.map((s) => s.sessionId));
  const stray = run.updates.filter((u) => !known.has(u.n.sessionId)).length;
  saveFixture(`measure/${kind}/concurrency.json`, { wallMs, rows, strayUpdates: stray });
  saveTranscript(`acp/${kind}/transcripts/concurrency.jsonl`, run.frames);
  expect(
    STEP,
    '3 个会话并发提示各自得到自己的结果',
    rows.every((r) => r.ok),
    rows,
  );
  expect(STEP, '所有 update 都能按 sessionId 归属', stray === 0, { wallMs });
  await run.close();
}
