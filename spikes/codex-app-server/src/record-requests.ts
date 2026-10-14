// 录真实的 Codex 请求体，给 packages/model-gateway 的映射测试当输入（R1）。
//
// 锁定版本的 codex-app-server 直连本地 Responses mock，按 Wevir 将来的配置（ADR-0005 决策 5 与补记 1：加固项、
// update_plan 打开、goals 关闭；模型目录声明 apply_patch、图片输入与推理档位）跑两个回合和一次手动压缩：
//   #0 第一回合的第一个请求；模型回推理 + 两个并行工具调用（apply_patch、exec_command）
//   #1 同一回合带着工具结果的第二个请求；模型回推理 + 文本
//   #2 第二回合（带图片，回合前改了审批策略，所以对话中间多一条 developer 消息）
//   #3 thread/compact/start 的压缩请求（tools 为空数组 + tool_choice，codex-notes §3.4 的 xAI 问题）
// 去掉本机路径与 id 后写到 packages/model-gateway/src/test-fixtures/codex-requests/。
//
// 用法：bash scripts/fetch-binary.sh && node src/record-requests.ts

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SPIKE_ROOT } from './codex-home.ts';
import { Harness, MOCK_MODEL, mockCatalog } from './harness.ts';
import type { Reply } from './model-script.ts';

const OUT = resolve(SPIKE_ROOT, '../../packages/model-gateway/src/test-fixtures/codex-requests');
const PATCH = ['*** Begin Patch', '*** Add File: notes.md', '+# 笔记', '*** End Patch'].join('\n');
/** 1×1 的红色 PNG。 */
const RED_DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

const h = await Harness.start('record', {
  transport: 'direct',
  script: (v): Reply => {
    if (v.index === 0) {
      return {
        reasoning: ['先建文件，', '再看目录。'],
        toolCalls: [
          { kind: 'custom', name: 'apply_patch', input: PATCH },
          { kind: 'function', name: 'exec_command', args: { cmd: 'ls' } },
        ],
      };
    }
    if (v.index === 1) return { reasoning: ['文件建好了。'], text: ['已新建 notes.md。'] };
    if (v.lastUserText.includes('[rec-2]')) return { text: ['是一个红点。'] };
    return { text: ['压缩后的摘要：新建了 notes.md，看过一张红点图。'] };
  },
});

try {
  // 换成 Wevir 将来的配置后重启（Harness 写的是 spike 的默认配置）。
  await h.server.close();
  const config = join(h.sandbox.codexHome, 'config.toml');
  writeFileSync(
    config,
    readFileSync(config, 'utf8').replace('plugins = false', 'plugins = false\ngoals = false'),
  );
  const catalog = mockCatalog(MOCK_MODEL) as { models: Array<Record<string, unknown>> };
  Object.assign(catalog.models[0] ?? {}, {
    input_modalities: ['text', 'image'],
    default_reasoning_level: 'high',
    supported_reasoning_levels: [
      { effort: 'low', description: 'low' },
      { effort: 'high', description: 'high' },
    ],
  });
  writeFileSync(join(h.sandbox.codexHome, 'wevir-models.json'), JSON.stringify(catalog, null, 2));
  h.spawn();
  await h.server.initialize(false);

  await h.startThread();
  const t1 = await h.turn('[rec-1] 新建 notes.md，然后看看目录里有什么。');
  console.log(`回合 1：${t1.status}`);
  const t2id = await h.server
    .request<{ turn: { id: string } }>('turn/start', {
      threadId: h.threadId,
      approvalPolicy: 'never',
      input: [
        { type: 'text', text: '[rec-2] 这张图里是什么？', text_elements: [] },
        { type: 'image', url: RED_DOT },
      ],
    })
    .then((r) => r.turn.id);
  const t2 = await h.server.waitTurnCompleted(h.threadId, t2id);
  console.log(`回合 2：${(t2.params.turn as { status: string }).status}`);
  await h.server.request('thread/compact/start', { threadId: h.threadId });
  await h.server.waitFor(
    (n) =>
      n.method === 'turn/completed' && n.params.threadId === h.threadId && h.modelRequests >= 4,
    30_000,
    '压缩回合结束',
  );

  const requests = h.responses?.requests ?? [];
  if (requests.length < 4) throw new Error(`只录到 ${requests.length} 个请求`);
  const scrub = makeScrubber(h.sandbox.root);
  const samples = [
    ['1-first-turn', '第一回合的第一个请求'],
    ['2-tool-results', '同一回合带着两个工具结果（apply_patch、exec_command）的第二个请求'],
    ['3-next-turn', '第二回合：带图片，对话中间有改审批策略后的 developer 消息'],
    ['4-compact', 'thread/compact/start 的压缩请求'],
  ] as const;
  mkdirSync(OUT, { recursive: true });
  samples.forEach(([name, description], index) => {
    const request = requests[index];
    if (request === undefined) return;
    const sample = {
      recordedBy: 'spikes/codex-app-server/src/record-requests.ts',
      codex: 'rust-v0.162.1 (092d3ac), codex-app-server, Responses mock',
      description,
      path: request.path,
      headers: Object.keys(request.headers).sort(),
      body: scrub(request.body),
    };
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(sample, null, 2)}\n`);
    console.log(`写入 ${name}.json（${JSON.stringify(sample).length} 字节）`);
  });
} finally {
  await h.dispose();
}

/**
 * 脱敏：本机路径与时区换成占位符，UUID 与 Codex 生成的 id 换成按出现顺序编号的占位符，基础提示词换成长度说明
 * （它是 Codex 的 prompt.md 原文，映射测试不关心内容）。
 */
function makeScrubber(root: string): (value: unknown) => unknown {
  const paths: Array<[string, string]> = [];
  for (const [dir, label] of [
    [join(root, 'workspace'), '<WORKSPACE>'],
    [join(root, 'codex-home'), '<CODEX_HOME>'],
    [join(root, 'home'), '<HOME>'],
    [join(root, 'tmp'), '<TMP>'],
    [root, '<ROOT>'],
    [SPIKE_ROOT, '<SPIKE>'],
    [homedir(), '<USER_HOME>'],
  ] as const) {
    paths.push([dir, label]);
    try {
      const real = realpathSync(dir);
      if (real !== dir) paths.push([real, label]);
    } catch {
      // 目录不在了：只替换原路径。
    }
  }
  paths.sort((a, b) => b[0].length - a[0].length);
  const ids = new Map<string, string>();
  const id = (raw: string, kind: string) => {
    const known = ids.get(raw);
    if (known !== undefined) return known;
    const label = `<${kind}-${ids.size + 1}>`;
    ids.set(raw, label);
    return label;
  };
  const text = (s: string): string => {
    if (s.length > 8000 && s.includes('Codex')) return `<BASE_INSTRUCTIONS: ${s.length} chars>`;
    let out = s;
    for (const [from, to] of paths) out = out.replaceAll(from, to);
    out = out.replace(/<timezone>[^<]*<\/timezone>/g, '<timezone><TIMEZONE></timezone>');
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) =>
      id(m.toLowerCase(), 'ID'),
    );
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk;
}
