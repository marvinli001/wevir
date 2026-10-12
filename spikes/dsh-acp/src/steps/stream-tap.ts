// 补充实验：ACP 只在 assistant 消息提交后整条下发，没有增量流式输出。
// 验证不 fork dsh 也能补上：把 stream-tap/（一个 Cordis 插件）用 `dsh plugin add link:` 装进 profile，
// 再用 --patch 插入它；插件把进程内 agent/assistant-stream 帧写到额外的 fd 3。

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import { initialize, prompt, saveFixture, startAcp } from '../acp.ts';
import {
  childEnv,
  DSH_BIN,
  DSH_HOME,
  ensureDir,
  GENERATED_DIR,
  makeWorkspace,
  SPIKE_DIR,
  target,
} from '../env.ts';
import { writeProviderOverlay } from '../overlays.ts';
import { expect, record } from '../report.ts';
import { prompts } from '../scenarios.ts';

const STEP = 'stream-tap';

export async function streamTap(): Promise<void> {
  const t = target();
  console.log(`\n▶ 增量流式补丁原型（${t.kind}）`);
  const add = spawnSync(
    process.execPath,
    [DSH_BIN, 'plugin', '--profile', 'acp', 'add', `link:${join(SPIKE_DIR, 'stream-tap')}`],
    { cwd: ensureDir(DSH_HOME), env: childEnv(), encoding: 'utf8' },
  );
  if (
    !expect(STEP, 'dsh plugin add link:stream-tap 成功', add.status === 0, add.stderr.slice(-400))
  ) {
    return;
  }
  const tapOverlay = join(ensureDir(GENERATED_DIR), 'stream-tap.yml');
  writeFileSync(
    tapOverlay,
    ['- insert:', '    - id: wevir-stream-tap', '      name: wevir-spike-stream-tap', ''].join(
      '\n',
    ),
  );
  const run = startAcp({
    label: 'stream-tap',
    overlays: [writeProviderOverlay(), tapOverlay],
    streamTap: true,
  });
  await initialize(run);
  const { sessionId } = await run.agent.request(methods.agent.session.new, {
    cwd: makeWorkspace('stream-tap'),
    mcpServers: [],
  });
  const out = await prompt(run, sessionId, prompts.stream);
  const acpChunks = out.updates.filter((u) => u.n.update.sessionUpdate === 'agent_message_chunk');
  // 每条形如 { sessionId, frame: { type: 'start' | 'chunk' | 'end', attemptId, index, chunk } }
  const tapped = out.tapFrames.map((x) => ({ dt: x.t - out.sentAt, ...(x.frame as object) }));
  const chunkTimes = out.tapFrames
    .filter((x) => (x.frame as { frame?: { type?: string } }).frame?.type === 'chunk')
    .map((x) => x.t - out.sentAt);
  const summary = {
    acp: {
      agentMessageChunks: acpChunks.length,
      firstAfterMs: acpChunks[0] === undefined ? undefined : acpChunks[0].t - out.sentAt,
    },
    tap: {
      frames: tapped.length,
      chunkFrames: chunkTimes.length,
      firstChunkAfterMs: chunkTimes[0],
      lastChunkAfterMs: chunkTimes.at(-1),
    },
    turnMs: out.settledAt - out.sentAt,
  };
  saveFixture(`stream-tap/${t.kind}/summary.json`, summary);
  saveFixture(
    `stream-tap/${t.kind}/frames.sample.json`,
    tapped.slice(0, 6).concat(tapped.slice(-2)),
  );
  record(STEP, 'ACP vs 旁路的分片时间', 'observe', summary);
  expect(
    STEP,
    '旁路分片先于 ACP 的整条消息到达（首片早于 ACP 至少 1 秒）',
    summary.tap.firstChunkAfterMs !== undefined &&
      summary.acp.firstAfterMs !== undefined &&
      summary.acp.firstAfterMs - summary.tap.firstChunkAfterMs > 1000,
  );
  await run.close();
}
