// 真实模型：同样的几件事交给真实上游做一遍。默认 DeepSeek（官方 Codex 接入文档：api-docs.deepseek.com
// quick_start/agent_integrations/codex，base_url https://api.deepseek.com/，Responses 原生）。
//
// Key 只从环境变量读，不写盘、不打印：
//   WEVIR_SPIKE_KEY=… node src/real.ts [--transport=direct,passthrough,gateway]
// 可选：WEVIR_SPIKE_RESPONSES_BASE_URL（默认 https://api.deepseek.com）、WEVIR_SPIKE_CHAT_BASE_URL（默认同上）、
//       WEVIR_SPIKE_MODEL（默认 deepseek-flash）、WEVIR_SPIKE_CHAT_MODEL（默认同上）、
//       WEVIR_SPIKE_CHAT_EXTRA（JSON，网关发给 Chat 上游的额外字段，例如思考开关）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, type RealUpstream, type Transport } from './harness.ts';

const key = process.env.WEVIR_SPIKE_KEY;
if (!key) {
  console.log('跳过：没有 WEVIR_SPIKE_KEY。真实模型这一层没有运行。');
  process.exit(0);
}
const real: RealUpstream = {
  responsesBaseURL: process.env.WEVIR_SPIKE_RESPONSES_BASE_URL ?? 'https://api.deepseek.com',
  chatBaseURL: process.env.WEVIR_SPIKE_CHAT_BASE_URL ?? 'https://api.deepseek.com',
  key,
  model: process.env.WEVIR_SPIKE_MODEL ?? 'deepseek-flash',
  chatModel:
    process.env.WEVIR_SPIKE_CHAT_MODEL ?? process.env.WEVIR_SPIKE_MODEL ?? 'deepseek-flash',
  chatExtraBody: process.env.WEVIR_SPIKE_CHAT_EXTRA
    ? JSON.parse(process.env.WEVIR_SPIKE_CHAT_EXTRA)
    : undefined,
};
const transports = (process.argv
  .find((a) => a.startsWith('--transport='))
  ?.slice(12)
  .split(',') ?? ['direct', 'passthrough', 'gateway']) as Transport[];

const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  console.log(s);
};

for (const transport of transports) {
  log(
    `\n## ${transport}（${transport === 'gateway' ? real.chatBaseURL : real.responsesBaseURL}，${transport === 'gateway' ? real.chatModel : real.model}）`,
  );
  const h = await Harness.start(`real-${transport}`, {
    transport,
    real,
    script: () => ({}),
    // 真实模型不自动放行越权：一律拒绝并记下来（场景本身都不需要越出工作区）。
    decide: (req) => {
      log(`  审批：${req.method} ${String(req.params.command ?? req.params.reason ?? '').slice(0, 80)} → decline`);
      return { decision: 'decline' };
    },
    extraTop: ['tools.update_plan.enabled = true'],
  });
  try {
    await h.startThread();
    const file = join(h.sandbox.workspace, 'hello.txt');
    const t1 = await h.turn(
      '用 apply_patch 工具在当前目录新建 hello.txt，内容只有一行：你好，Wevir。不要用 shell 写文件。',
      180_000,
    );
    const patchItems = h.itemsCompleted(t1.id, 'fileChange');
    log(
      `  回合 1：${t1.status}；fileChange ${patchItems.length} 个；文件${existsSync(file) ? `内容=${JSON.stringify(readFileSync(file, 'utf8'))}` : '不存在'}`,
    );
    const ns1 = h.notificationsFor(t1.id);
    log(
      `  回合 1 增量：agentMessage ${ns1.filter((n) => n.method === 'item/agentMessage/delta').length} 条，reasoning ${ns1.filter((n) => n.method.startsWith('item/reasoning/')).length} 条`,
    );
    if (t1.error) log(`  回合 1 错误：${JSON.stringify(t1.error).slice(0, 300)}`);

    const t2 = await h.turn(
      '再用 apply_patch 把 hello.txt 的内容改成：再见，Wevir。然后用一句话告诉我你上一轮做了什么。',
      180_000,
    );
    log(
      `  回合 2（跨回合带回推理项）：${t2.status}；文件${existsSync(file) ? `内容=${JSON.stringify(readFileSync(file, 'utf8'))}` : '不存在'}`,
    );
    if (t2.error) log(`  回合 2 错误：${JSON.stringify(t2.error).slice(0, 300)}`);
    const answer = h.itemsCompleted(t2.id, 'agentMessage').at(-1);
    log(`  回合 2 回答：${String(answer?.text ?? '').slice(0, 120)}`);

    const t3 = await h.turn(
      '请调用 spawn_agent 派一个子 agent，让它数一下当前目录有几个文件，然后用 wait_agent 等它的结果并告诉我。',
      240_000,
    );
    const collab = h.itemsCompleted(t3.id, 'collabAgentToolCall');
    log(
      `  回合 3（子 agent，namespace 工具）：${t3.status}；collabAgentToolCall ${collab.map((c) => `${c.tool}/${c.status}`).join(',') || '无'}`,
    );
    if (t3.error) log(`  回合 3 错误：${JSON.stringify(t3.error).slice(0, 300)}`);

    const t4id = await h.startTurn('写一篇 800 字的短文，主题是本地优先软件。');
    await h.server.waitFor(
      (n) => n.method === 'item/agentMessage/delta' && n.params.turnId === t4id,
      120_000,
      '首个增量',
    );
    const t0 = performance.now();
    await h.server.request('turn/interrupt', { threadId: h.threadId, turnId: t4id });
    const t4 = await h.server.waitTurnCompleted(h.threadId, t4id, 30_000);
    log(
      `  回合 4（取消）：${(t4.params.turn as { status: string }).status}，${Math.round(performance.now() - t0)} ms`,
    );
    if (h.gateway && transport === 'gateway')
      log(`  网关丢弃的输入项类型：${JSON.stringify([...new Set(h.gateway.dropped)])}`);
  } catch (error) {
    log(`  出错：${(error as Error).message}`);
    log(`  stderr 末尾：${h.server.stderr.slice(-5).join(' | ').slice(0, 600)}`);
  } finally {
    await h.dispose();
  }
}
