// 不需要 Key 的协议面：initialize、session/new、list、close、resume 及其错误，
// 以及缺少 Key 时 session/prompt 的失败形态、overlay 组合结果。

import { spawnSync } from 'node:child_process';
import { methods } from '@agentclientprotocol/sdk';
import {
  type AcpRun,
  errorInfo,
  type Frame,
  initialize,
  prompt,
  saveFixture,
  saveTranscript,
  startAcp,
} from '../acp.ts';
import { childEnv, DSH_BIN, DSH_HOME, KEY_ENV, makeWorkspace, PLACEHOLDER_TARGET } from '../env.ts';
import { DEEPSEEK_OFFICIAL_OVERLAY, writeProviderOverlay } from '../overlays.ts';
import { expect, record } from '../report.ts';

const STEP = 'lifecycle';

function frameOf(run: AcpRun, method: string, dir: Frame['dir'] = 'c2a'): Frame | undefined {
  return run.frames.find((f) => f.dir === dir && 'method' in f.msg && f.msg.method === method);
}

function responseTo(run: AcpRun, request: Frame | undefined): Frame | undefined {
  if (request === undefined || !('id' in request.msg)) return undefined;
  const id = request.msg.id;
  return run.frames.find(
    (f) => f.dir === 'a2c' && 'id' in f.msg && f.msg.id === id && !('method' in f.msg),
  );
}

async function capture<T>(fn: () => Promise<T>): Promise<{ ok: T } | { error: unknown }> {
  try {
    return { ok: await fn() };
  } catch (error) {
    return { error: errorInfo(error) };
  }
}

export async function lifecycle(): Promise<void> {
  console.log('\n▶ ACP 生命周期（无需 Key）');
  const run = startAcp({ label: 'lifecycle' });
  const init = await initialize(run);
  const initReq = frameOf(run, 'initialize');
  saveFixture('acp/initialize.request.json', initReq?.msg);
  saveFixture('acp/initialize.response.json', responseTo(run, initReq)?.msg);
  expect(STEP, 'initialize 返回 protocolVersion 1', init.protocolVersion === 1);
  record(STEP, 'agentCapabilities', 'observe', init.agentCapabilities);

  const ws = makeWorkspace('lifecycle');
  const created = await run.agent.request(methods.agent.session.new, { cwd: ws, mcpServers: [] });
  saveFixture('acp/session-new.request.json', frameOf(run, 'session/new')?.msg);
  saveFixture('acp/session-new.response.json', responseTo(run, frameOf(run, 'session/new'))?.msg);
  record(
    STEP,
    'session/new configOptions',
    'observe',
    created.configOptions?.map((o) => o.id),
  );

  const listActive = await run.agent.request(methods.agent.session.list, { cwd: ws });
  expect(STEP, '活跃会话不出现在 session/list', listActive.sessions.length === 0, listActive);

  const resumeActive = await capture(() =>
    run.agent.request(methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: ws,
      mcpServers: [],
    }),
  );
  saveFixture('acp/errors/resume-active-session.json', resumeActive);
  expect(STEP, 'resume 活跃会话被拒绝', 'error' in resumeActive);

  await run.agent.request(methods.agent.session.close, { sessionId: created.sessionId });
  saveFixture(
    'acp/session-close.response.json',
    responseTo(run, frameOf(run, 'session/close'))?.msg,
  );
  const listed = await run.agent.request(methods.agent.session.list, { cwd: ws });
  saveFixture('acp/session-list.response.json', responseTo(run, frameOf(run, 'session/list'))?.msg);
  expect(
    STEP,
    '关闭后出现在 session/list，且只有 sessionId + cwd',
    listed.sessions.some((s) => s.sessionId === created.sessionId),
    listed.sessions[0],
  );

  const wrongCwd = await capture(() =>
    run.agent.request(methods.agent.session.resume, {
      sessionId: created.sessionId,
      cwd: makeWorkspace('other'),
      mcpServers: [],
    }),
  );
  saveFixture('acp/errors/resume-cwd-mismatch.json', wrongCwd);
  expect(STEP, 'resume 时 cwd 不一致被拒绝', 'error' in wrongCwd);

  const resumed = await run.agent.request(methods.agent.session.resume, {
    sessionId: created.sessionId,
    cwd: ws,
    mcpServers: [],
  });
  saveFixture('acp/session-resume.response.json', { jsonrpc: '2.0', result: resumed });
  expect(STEP, '同进程 close → resume 成功', resumed !== undefined);
  expect(STEP, 'resume 不回放任何 session/update', run.updates.length === 0, run.updates.length);

  const closeUnknown = await capture(() =>
    run.agent.request(methods.agent.session.close, { sessionId: 'no-such-session' }),
  );
  saveFixture('acp/errors/close-unknown-session.json', closeUnknown);
  const loadUnsupported = await capture(() =>
    run.agent.request(methods.agent.session.load, {
      sessionId: created.sessionId,
      cwd: ws,
      mcpServers: [],
    }),
  );
  saveFixture('acp/errors/session-load-unsupported.json', loadUnsupported);
  expect(STEP, 'session/load 不支持', 'error' in loadUnsupported);
  await run.close();
  saveTranscript('acp/transcripts/lifecycle.jsonl', run.frames);

  // 缺少 Key：两种 Provider 下 prompt 的失败形态（不发起任何网络请求之前就失败）
  for (const [name, overlay] of [
    ['openai-compatible', writeProviderOverlay(PLACEHOLDER_TARGET)],
    ['deepseek-official', DEEPSEEK_OFFICIAL_OVERLAY],
  ] as const) {
    const noKey = startAcp({
      label: `nokey-${name}`,
      overlays: [overlay],
      env: { [KEY_ENV]: undefined },
    });
    await initialize(noKey);
    const s = await noKey.agent.request(methods.agent.session.new, {
      cwd: makeWorkspace('nokey'),
      mcpServers: [],
    });
    if (name === 'openai-compatible') {
      saveFixture('acp/session-new.openai-compatible.response.json', {
        jsonrpc: '2.0',
        result: s,
      });
      const model = s.configOptions?.find((o) => o.id === 'model');
      expect(
        STEP,
        'overlay 声明的 OpenAI 兼容 Provider 出现在 model 配置项',
        JSON.stringify(model).includes(PLACEHOLDER_TARGET.providerId),
        model?.currentValue,
      );
    }
    const out = await prompt(noKey, s.sessionId, '回复 OK');
    saveFixture(`acp/errors/prompt-missing-key.${name}.json`, {
      response: out.response,
      error: errorInfo(out.error),
      updates: out.updates.map((u) => u.n),
    });
    record(STEP, `缺少 Key 时 prompt 的结果（${name}）`, 'observe', {
      stopReason: out.response?.stopReason,
      error: errorInfo(out.error),
      updates: out.updates.length,
    });
    await noKey.close();
  }

  // overlay 组合结果：--dump-config 确认 llm-pi-ai 与 acp 两行被替换
  const dump = spawnSync(
    process.execPath,
    [
      DSH_BIN,
      '--profile',
      'acp',
      '--patch',
      writeProviderOverlay(PLACEHOLDER_TARGET),
      '--dump-config',
    ],
    { cwd: DSH_HOME, env: childEnv(), encoding: 'utf8' },
  );
  const text = dump.stdout;
  expect(
    STEP,
    '--dump-config 中可见 overlay 的 Provider 与 acp 路由',
    text.includes(PLACEHOLDER_TARGET.providerId) && text.includes(`apiKeyEnv: ${KEY_ENV}`),
    { exit: dump.status, bytes: text.length },
  );
}
