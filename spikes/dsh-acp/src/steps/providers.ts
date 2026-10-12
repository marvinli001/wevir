// 步骤 3：Provider 注入。OpenAI 兼容 Provider（llm-pi-ai + apiKeyEnv）与 DeepSeek 官方最小配置，
// 各发一次最小提示，确认路由真的走通、Key 只经环境变量进入请求头；
// 随后由 check-secrets 确认 DSH_HOME 没有明文 Key。

import { methods } from '@agentclientprotocol/sdk';
import {
  errorInfo,
  initialize,
  prompt,
  saveFixture,
  saveTranscript,
  startAcp,
  summarizeUpdates,
} from '../acp.ts';
import { makeWorkspace, target } from '../env.ts';
import { activeMock, MOCK_KEY } from '../mock-llm.ts';
import {
  DEEPSEEK_OFFICIAL_OVERLAY,
  writeDeepSeekOfficialMockOverlay,
  writeProviderOverlay,
} from '../overlays.ts';
import { expect, record } from '../report.ts';
import { prompts } from '../scenarios.ts';

const STEP = 'providers';

export async function providers(): Promise<void> {
  const t = target();
  const mock = activeMock();
  console.log(`\n▶ Provider 注入（${t.kind}）`);
  const cases: Array<{ name: string; overlay: string; route: string; header: string }> = [
    {
      name: 'openai-compatible',
      overlay: writeProviderOverlay(),
      route: `${t.providerId} / ${t.model} @ ${t.baseURL}`,
      header: 'authorization',
    },
  ];
  if (mock !== undefined) {
    cases.push({
      name: 'deepseek-official',
      overlay: writeDeepSeekOfficialMockOverlay(new URL(mock.baseURL).origin),
      route: 'deepseek-official / deepseek-v4-flash → mock /anthropic/v1/messages',
      header: 'x-api-key',
    });
  } else if (/(^|\.)deepseek\.com$/.test(new URL(t.baseURL).hostname)) {
    cases.push({
      name: 'deepseek-official',
      overlay: DEEPSEEK_OFFICIAL_OVERLAY,
      route: 'deepseek-official / deepseek-v4-flash（acp-app 默认）',
      header: 'x-api-key',
    });
  } else {
    record(STEP, 'deepseek-official：Key 不是 DeepSeek 平台的，跳过', 'skip');
  }

  for (const c of cases) {
    const r0 = mock?.requests.length ?? 0;
    const run = startAcp({ label: `provider-${c.name}`, overlays: [c.overlay] });
    await initialize(run);
    const s = await run.agent.request(methods.agent.session.new, {
      cwd: makeWorkspace('provider'),
      mcpServers: [],
    });
    const out = await prompt(run, s.sessionId, prompts.ok);
    const { counts, assistantText } = summarizeUpdates(out.updates);
    const seen = mock?.requests.slice(r0).map((r) => ({ path: r.path, auth: r.auth }));
    saveFixture(`providers/${t.kind}/${c.name}.json`, {
      route: c.route,
      stopReason: out.response?.stopReason,
      error: errorInfo(out.error),
      updateCounts: counts,
      assistantText,
      durationMs: out.settledAt - out.sentAt,
      mockSaw: seen,
    });
    saveTranscript(`providers/${t.kind}/${c.name}.jsonl`, run.frames);
    const ok = out.response?.stopReason === 'end_turn' && /ok/i.test(assistantText);
    expect(STEP, `${c.name}：最小提示走通（${c.route}）`, ok, {
      stopReason: out.response?.stopReason,
      text: assistantText.slice(0, 40),
      error: errorInfo(out.error),
    });
    if (seen !== undefined) {
      const expected = c.header === 'authorization' ? `Bearer ${MOCK_KEY}` : MOCK_KEY;
      expect(
        STEP,
        `${c.name}：apiKeyEnv 的值出现在 ${c.header} 请求头`,
        seen.length > 0 && seen.every((r) => r.auth === expected),
        seen.map((r) => r.path),
      );
    }
    if (!ok) record(STEP, `${c.name} stderr`, 'observe', run.stderrTail().slice(-1500));
    await run.close();
  }
}
