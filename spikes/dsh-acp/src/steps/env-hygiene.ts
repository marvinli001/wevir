// 进程环境卫生（只在 mock 模式跑，全部用假数据）：
// a) dsh 会把 <进程 cwd>/.env 当作凭据回退；b) dsh 会读 $DSH_AGENTS_HOME 的 skills/ 与 AGENTS.md；
// c) 隔离后（childEnv 默认）这些都不进入模型请求。

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import { initialize, prompt, saveFixture, startAcp } from '../acp.ts';
import { DSH_HOME, KEY_ENV, makeWorkspace } from '../env.ts';
import { activeMock, textOf } from '../mock-llm.ts';
import { writeProviderOverlay } from '../overlays.ts';
import { expect, record } from '../report.ts';
import { prompts } from '../scenarios.ts';

const STEP = 'env-hygiene';
const DOTENV_KEY = 'wevir-dotenv-value-not-a-secret';
const SKILL = 'wevir-probe-skill';
const MARKER = 'WEVIR_AGENTS_MD_MARKER';

async function firstRequest(opts: Parameters<typeof startAcp>[0]) {
  const mock = activeMock();
  if (mock === undefined) throw new Error('env-hygiene 只在 mock 模式运行');
  const r0 = mock.requests.length;
  const run = startAcp(opts);
  await initialize(run);
  const { sessionId } = await run.agent.request(methods.agent.session.new, {
    cwd: makeWorkspace('hygiene'),
    mcpServers: [],
  });
  const out = await prompt(run, sessionId, prompts.ok);
  await run.close();
  const req = mock.requests[r0];
  const text = (req?.body.messages ?? []).map((m) => textOf(m.content)).join('\n');
  return { out, auth: req?.auth, text };
}

export async function envHygiene(): Promise<void> {
  if (activeMock() === undefined) return;
  console.log('\n▶ 进程环境卫生（mock，假数据）');
  const overlay = writeProviderOverlay();

  // a) 进程 cwd 下的 .env
  const cwdWithDotenv = makeWorkspace('dotenv');
  writeFileSync(join(cwdWithDotenv, '.env'), `${KEY_ENV}=${DOTENV_KEY}\n`);
  const a = await firstRequest({
    label: 'dotenv',
    overlays: [overlay],
    processCwd: cwdWithDotenv,
    env: { [KEY_ENV]: undefined },
  });
  expect(
    STEP,
    '环境里没有 Key 时，dsh 读取 <进程 cwd>/.env 并把其中的值发给 Provider',
    a.auth === `Bearer ${DOTENV_KEY}`,
    {
      stopReason: a.out.response?.stopReason,
      authSeen: a.auth?.replace(DOTENV_KEY, '<DOTENV_KEY>'),
    },
  );

  // b) 未隔离的 DSH_AGENTS_HOME
  const agentsHome = makeWorkspace('agents-home');
  mkdirSync(join(agentsHome, 'skills', SKILL), { recursive: true });
  writeFileSync(
    join(agentsHome, 'skills', SKILL, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Spike probe skill.\n---\n\nprobe\n`,
  );
  writeFileSync(join(agentsHome, 'AGENTS.md'), `${MARKER}\n`);
  const b = await firstRequest({
    label: 'agents-home',
    overlays: [overlay],
    env: { DSH_AGENTS_HOME: agentsHome },
  });
  expect(STEP, '$DSH_AGENTS_HOME/skills 进入模型请求', b.text.includes(SKILL));
  expect(STEP, '$DSH_AGENTS_HOME/AGENTS.md 进入模型请求', b.text.includes(MARKER));

  // c) 默认隔离
  const c = await firstRequest({ label: 'isolated', overlays: [overlay] });
  expect(
    STEP,
    '隔离后（空 DSH_AGENTS_HOME、进程 cwd 为 DSH_HOME）请求里没有这些内容',
    !c.text.includes(SKILL) && !c.text.includes(MARKER),
  );
  saveFixture('env-hygiene/mock/summary.json', {
    dotenvFallbackAuthSeen: a.auth === `Bearer ${DOTENV_KEY}`,
    agentsHomeSkillInRequest: b.text.includes(SKILL),
    agentsHomeAgentsMdInRequest: b.text.includes(MARKER),
    isolatedRequestChars: c.text.length,
    agentsHomeRequestChars: b.text.length,
  });
  record(STEP, 'DSH_HOME 顶层内容', 'observe', readdirSync(DSH_HOME).sort());
}
