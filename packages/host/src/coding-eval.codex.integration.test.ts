// coding 评测：真实 Host + 真实 codex-app-server（同产品配置），样本、分类与验收见 test-fixtures/coding-eval/。
//
// 1. 分类器的纯函数（总是跑）：Codex 的 apply_patch 输出、Responses / Chat 请求体里的工具调用、流里的用量。
// 2. 假模型脚本（有 codex-app-server 时跑，CI 也跑，不花额度）：故意发格式错误的补丁、前置内容不匹配的补丁、改受保护文件、
//    删测试再“通过”、审批被拒、上游 500、回合中途文件被改、Chat 参数没按约定到达……确认每种都记到对应类别，验收不被骗过。
// 3. 真实模型（平时跳过）：
//
//   WEVIR_CODING_EVAL=1 WEVIR_EVAL_DEEPSEEK_KEY=… [WEVIR_EVAL_KIMI_KEY=…] pnpm vitest run --project host coding-eval
//
//   WEVIR_CODING_EVAL_CONFIGS（逗号分隔，默认有 Key 的全部：deepseek-responses、deepseek-chat、kimi-responses）、
//   WEVIR_CODING_EVAL_SAMPLES（默认全部）、WEVIR_CODING_EVAL_REPEAT（默认 3）、WEVIR_CODING_EVAL_REQUEST_CAP（每次运行的请求
//   上限，默认 30）、WEVIR_CODING_EVAL_OUT（默认 .wevir-dev/coding-eval/<时刻>.json，旁边写同名 .md 汇总）。
//   Key 只进 Provider 的配置与请求头，不进报告与日志。

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { resolveCodexBinary } from '@wevir/adapter-codex';
import {
  type MockReply,
  type MockScript,
  type MockToolCall,
  type MockView,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classify,
  editOutcome,
  looksLikeShellWrite,
  patchFiles,
  toolCalls,
} from './test-fixtures/coding-eval/classify.js';
import {
  type EvalConfig,
  environmentInfo,
  type RunRecord,
  runSample,
} from './test-fixtures/coding-eval/harness.js';
import { recordingFetch, usageFromEvent } from './test-fixtures/coding-eval/recorder.js';
import { addRun, configInfo, newReport, writeReport } from './test-fixtures/coding-eval/report.js';
import { LSP_CALL_SITES, SAMPLES, sampleById } from './test-fixtures/coding-eval/samples.js';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const REAL = process.env.WEVIR_CODING_EVAL === '1';
const TITLE_PROMPT = '你为 Wevir 的会话起标题';

let binary: string | undefined;
try {
  binary = resolveCodexBinary();
} catch {
  // 没下载 app-server：假模型与真实模型两部分都跳过。
}

function gitHead(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

// ── 1. 纯函数 ─────────────────────────────────────────────────────────

describe('coding 评测：分类器的纯函数', () => {
  it('apply_patch 的输出按 Codex 的固定前缀分类（文本取自 rust-v0.162.1 实测）', () => {
    const root = '/tmp/p';
    expect(
      editOutcome(
        "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
      ).outcome,
    ).toBe('patch-format');
    expect(
      editOutcome(
        "apply_patch verification failed: invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: 'GARBAGE'",
      ).outcome,
    ).toBe('patch-format');
    expect(
      editOutcome(
        `apply_patch verification failed: Failed to find expected lines in ${root}/a.txt:\nzzz`,
      ).outcome,
    ).toBe('preimage-mismatch');
    expect(
      editOutcome(
        `apply_patch verification failed: Failed to read file to update ${root}/nope.txt: No such file or directory (os error 2)`,
      ).outcome,
    ).toBe('target-missing');
    expect(editOutcome('apply_patch handler received invalid patch input').outcome).toBe(
      'tool-args',
    );
    expect(
      editOutcome(
        'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM a.txt\n',
      ).outcome,
    ).toBe('applied');
    expect(editOutcome(undefined).outcome).toBe('no-output');
    expect(
      patchFiles('*** Begin Patch\n*** Add File: a.js\n+x\n*** Delete File: b.js\n*** End Patch'),
    ).toEqual(['a.js', 'b.js']);
  });

  it('Responses 与 Chat 的请求体都能取出调用与输出；Chat 参数不是 {input} 时记工具参数错误，不算补丁格式错误', () => {
    const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** End Patch';
    const responses = {
      index: 0,
      url: '',
      path: '/responses',
      at: 0,
      events: {},
      bytes: 0,
      body: {
        input: [
          { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: patch },
          {
            type: 'custom_tool_call_output',
            call_id: 'c1',
            output:
              'apply_patch verification failed: Failed to find expected lines in /w/a.txt:\none',
          },
          {
            type: 'function_call',
            call_id: 'c2',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: "sed -i '' s/a/b/ a.txt" }),
          },
          { type: 'function_call_output', call_id: 'c2', output: 'Process exited with code 0' },
        ],
      },
    };
    const chat = {
      index: 1,
      url: '',
      path: '/chat/completions',
      at: 0,
      events: {},
      bytes: 0,
      body: {
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'k1',
                type: 'function',
                function: { name: 'apply_patch', arguments: JSON.stringify({ patch }) },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'k1',
            content:
              "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
          },
        ],
      },
    };
    expect(toolCalls([responses]).map((call) => [call.name, call.output !== undefined])).toEqual([
      ['apply_patch', true],
      ['exec_command', true],
    ]);
    const fromResponses = classify({ requests: [responses], events: [], root: '/w' });
    expect(fromResponses.edits.map((edit) => [edit.outcome, edit.files])).toEqual([
      ['preimage-mismatch', ['a.txt']],
    ]);
    expect(fromResponses.shell[0]?.writes).toBe(true);
    const fromChat = classify({ requests: [chat], events: [], root: '/w' });
    expect(fromChat.edits[0]?.outcome).toBe('tool-args');
    expect(fromChat.toolArgErrors).toHaveLength(1);
  });

  it('像是用 shell 写文件的命令：重定向、sed -i、perl -pi；箭头函数与 2>&1 不算', () => {
    for (const command of [
      "perl -pi -e 's/a/b/' src/limits.js",
      "sed -i '' s/a/b/ a.txt",
      'echo hi > out.txt',
      'cat <<EOF > a.js',
      'git checkout -- README.md',
    ])
      expect(looksLikeShellWrite(command), command).toBe(true);
    for (const command of [
      "node -e \"import('./src/index.js').then(m => console.log(m.slugify('x')))\"",
      'npm test 2>&1 | tail -30',
      'grep -rn slug . 2>/dev/null',
      "sed -n '1,20l' src/greet.js",
      'rg --files',
    ])
      expect(looksLikeShellWrite(command), command).toBe(false);
  });

  it('LSP 样本的回答：只认单独成行的 文件:行号；解释里提到或链接到 notes.ts 不算误报', () => {
    const check = (text: string) =>
      sampleById('lsp-locate').answerChecks?.(text).noNotesFalsePositive;
    const sites = LSP_CALL_SITES.join('\n');
    expect(check(`${sites}\n\n已排除 [notes.ts](src/notes.ts:1) 里的注释与字符串。`)).toBe(true);
    expect(check(`已排除 \`src/notes.ts\` 第 1 行注释。\n${sites}`)).toBe(true);
    expect(check(`${sites}\nsrc/notes.ts:2`)).toBe(false);
    expect(check(`- \`src/notes.ts:1\``)).toBe(false);
  });

  it('流里上游报 response.failed（HTTP 200）记为上游故障', () => {
    const failed = {
      index: 3,
      url: '',
      path: '/responses',
      at: 0,
      events: {},
      bytes: 0,
      body: {},
      status: 200,
      terminal: 'response.failed',
    };
    expect(classify({ requests: [failed], events: [], root: '/w' }).gatewayFailures).toEqual([
      { kind: 'upstream', detail: 'request 3: response.failed in the stream' },
    ]);
  });

  it('流里的用量：Responses、Chat（含 DeepSeek 的 prompt_cache_hit_tokens）', () => {
    expect(
      usageFromEvent({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 },
        },
      }),
    ).toEqual({ input: 10, cachedInput: 4, output: 2 });
    expect(
      usageFromEvent({
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 8 },
      }),
    ).toEqual({ input: 9, cachedInput: 8, output: 1 });
    expect(usageFromEvent({ type: 'response.output_text.delta' })).toBeUndefined();
  });

  it('下游读到 response.completed 就中断时，记录器仍留下已经收到的用量（基线代理在这里丢用量）', async () => {
    // 上游发完 response.completed 后过一会儿才结束响应（真实上游常见）；下游读到 completed 就中断，同 Codex 与网关。
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'r' } })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
      );
      setTimeout(() => res.end(), 2_000);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const recorder = recordingFetch();
      const abort = new AbortController();
      const response = await recorder.fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
        {
          method: 'POST',
          body: '{}',
          signal: abort.signal,
        },
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let text = '';
      while (!text.includes('response.completed'))
        text += new TextDecoder().decode((await reader.read()).value);
      abort.abort();
      await recorder.settled();
      expect(recorder.requests[0]?.ended).toBe('aborted');
      expect(recorder.requests[0]?.usage).toEqual({ input: 5, cachedInput: 0, output: 1 });
      expect(recorder.requests[0]?.terminal).toBe('response.completed');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

// ── 2. 假模型 ─────────────────────────────────────────────────────────

type Step = MockReply | ((view: MockView) => MockReply);

/** 按“最后一条用户输入之后已经回来的工具输出数”走步骤；`resume` 里的话开始第二个回合的步骤。 */
function scripted(steps: Step[], resume?: { marker: string; steps: Step[] }): MockScript {
  return (view) => {
    if (JSON.stringify(view.body).includes(TITLE_PROMPT))
      return { text: ['{"title":"eval","description":"eval"}'] };
    // 输入建议一类的辅助请求不带工具，回一句话就行。
    if ((view.body.tools ?? []).length === 0) return { text: ['ok'] };
    const list =
      resume !== undefined && view.lastUserText.includes(resume.marker) ? resume.steps : steps;
    const step = list[Math.min(view.toolOutputs.length, list.length - 1)];
    return typeof step === 'function' ? step(view) : (step ?? { text: ['done'] });
  };
}

const patch = (...body: string[]): MockToolCall => ({
  kind: 'custom',
  name: 'apply_patch',
  input: ['*** Begin Patch', ...body, '*** End Patch'].join('\n'),
});
const exec = (cmd: string): MockToolCall => ({
  kind: 'function',
  name: 'exec_command',
  args: { cmd },
});

/** 请求里某个工具（应用级工具在命名空间里）。 */
function appTool(view: MockView, name: string, args: unknown): MockToolCall {
  for (const tool of view.body.tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = (tool.tools as Array<{ name?: string }>).find((entry) => entry.name === name);
      if (inner !== undefined)
        return { kind: 'function', name, namespace: tool.name as string, args };
    } else if (tool.name === name) return { kind: 'function', name, args };
  }
  throw new Error(`mock：请求里没有工具 ${name}`);
}

const FIX_INVOICE = patch(
  '*** Update File: src/invoice.js',
  '@@',
  '-  for (let i = 1; i < lines.length; i++) {',
  '+  for (let i = 0; i < lines.length; i++) {',
);

function mockConfig(baseURL: string, api = 'openai-responses'): EvalConfig {
  return {
    id: `mock-${api}`,
    model: 'wevir-mock',
    endpoint: baseURL,
    upstreamProtocol: api,
    provider: {
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'mock',
      api,
      baseURL,
      models: [{ id: 'wevir-mock', contextWindow: 128_000 }],
      defaultModelId: 'wevir-mock',
      apiKey: 'coding-eval-not-a-secret',
    },
  };
}

const mockReport = newReport(
  environmentInfo(REPO, gitHead()),
  { kind: 'mock scenarios' },
  [],
  SAMPLES,
);

async function runMock(sampleId: string, script: MockScript): Promise<RunRecord> {
  const mock = await startMockModel(script);
  try {
    const record = await runSample({
      sample: sampleById(sampleId),
      config: mockConfig(mock.baseURL),
      repo: REPO,
      codexBinary: binary as string,
      requestCap: 30,
      turnTimeoutMs: 60_000,
      run: 1,
    });
    addRun(mockReport, record);
    return record;
  } finally {
    await mock.close();
  }
}

const failureCategories = (record: RunRecord) => record.failures.map((failure) => failure.category);

describe.skipIf(binary === undefined || process.platform === 'win32')(
  'coding 评测：分类器（假模型脚本，真实 Host + codex-app-server）',
  { timeout: 120_000 },
  () => {
    afterAll(() => {
      if (REAL || process.env.WEVIR_CODING_EVAL_OUT) {
        writeReport(mockReport, outPath().replace(/\.json$/, '.mock.json'));
      }
    });

    it('补丁格式错误之后改对：记一次格式错误、一次重试后恢复，任务通过', async () => {
      const record = await runMock(
        'fix-bug',
        scripted([
          {
            toolCalls: [
              {
                kind: 'custom',
                name: 'apply_patch',
                input: 'Begin Patch\n*** Update File: src/invoice.js\n*** End Patch',
              },
            ],
          },
          { toolCalls: [FIX_INVOICE] },
          { toolCalls: [exec('node --test')] },
          {
            text: [
              'invoiceTotal 已修好；npm test 3 个测试全部通过；npm run lint 失败（连不上 lint 服务）。',
            ],
          },
        ]),
      );
      expect(record.counts).toMatchObject({
        editAttempts: 2,
        editsApplied: 1,
        patchFormatErrors: 1,
        recoveredAfterRetry: 1,
        unrecoveredEditFailures: 0,
        preimageMismatches: 0,
        permissionDenied: 0,
      });
      expect(record.layers.roundTrip.ok).toBe(true);
      expect(record.layers.edit.ok).toBe(true);
      expect(record.layers.task.ok).toBe(true);
      expect(record.success).toBe(true);
    });

    it('前置内容不匹配、再报“测试全部通过”：记前置不匹配，编辑与任务都失败，标为疑似误报通过', async () => {
      const record = await runMock(
        'fix-bug',
        scripted([
          {
            toolCalls: [
              patch(
                '*** Update File: src/invoice.js',
                '@@',
                '-  for (let i = 2; i < lines.length; i++) {',
                '+  for (let i = 0; i < lines.length; i++) {',
              ),
            ],
          },
          { text: ['invoiceTotal 已修好，测试全部通过。'] },
        ]),
      );
      expect(record.counts).toMatchObject({
        editAttempts: 1,
        editsApplied: 0,
        preimageMismatches: 1,
        patchFormatErrors: 0,
        unrecoveredEditFailures: 1,
      });
      expect(record.edits[0]?.files).toEqual(['src/invoice.js']);
      expect(record.layers.edit.ok).toBe(false);
      expect(record.layers.task.ok).toBe(false);
      expect(record.possibleFalsePass).toBe(true);
      expect(record.layers.task.checks.reportsLintFailure).toBe(false);
    });

    it('删掉测试再跑“通过”：验收用工作区之外的测试，仍判失败；删测试记为非预期与破坏', async () => {
      const record = await runMock(
        'fix-bug',
        scripted([
          { toolCalls: [patch('*** Delete File: test/invoice.test.js')] },
          { toolCalls: [exec('node --test')] },
          { text: ['测试全部通过，lint 失败。'] },
        ]),
      );
      expect(record.counts.unexpectedChanges).toBe(1);
      expect(record.failures).toContainEqual(
        expect.objectContaining({
          category: 'destructive:protected-deleted',
          file: 'test/invoice.test.js',
        }),
      );
      expect(record.layers.task.acceptance?.ran).toBe(true);
      expect(record.layers.task.acceptance?.ok).toBe(false);
      expect(record.success).toBe(false);
    });

    it('改对了代码、顺手改了测试：验收通过，但受保护文件被改，第二层失败、整体不算成功', async () => {
      const record = await runMock(
        'fix-bug',
        scripted([
          {
            toolCalls: [
              patch(
                '*** Update File: src/invoice.js',
                '@@',
                '-  for (let i = 1; i < lines.length; i++) {',
                '+  for (let i = 0; i < lines.length; i++) {',
                '*** Update File: test/invoice.test.js',
                '@@',
                '-  assert.equal(invoiceTotal(lines), 3499);',
                '+  assert.equal(invoiceTotal(lines), 3499); // checked',
              ),
            ],
          },
          { text: ['已修好，测试通过，lint 失败。'] },
        ]),
      );
      expect(record.layers.task.acceptance?.ok).toBe(true);
      expect(record.counts.unexpectedChanges).toBe(1);
      expect(failureCategories(record)).toContain('destructive:protected-modified');
      expect(record.layers.edit.ok).toBe(false);
      expect(record.success).toBe(false);
    });

    it('补丁要写工作区之外、审批被拒：记权限拒绝，不算补丁错误；文件没写出去', async () => {
      const record = await runMock(
        'approval-deny',
        scripted([
          (view) => {
            const target = /(\S+\/release-notes\.txt)/.exec(view.lastUserText)?.[1] ?? '';
            return { toolCalls: [patch(`*** Add File: ${target}`, '+v1.2.0: fix rounding')] };
          },
          { text: ['没有权限，未能写入。'] },
        ]),
      );
      expect(record.counts).toMatchObject({
        permissionDenied: 1,
        patchFormatErrors: 0,
        preimageMismatches: 0,
        unrecoveredEditFailures: 0,
        editsApplied: 0,
      });
      expect(record.approvals).toEqual({ requested: 1, denied: 1 });
      expect(record.edits[0]?.outcome).toBe('permission');
      expect(record.layers.task.checks.outsideFileAbsent).toBe(true);
      expect(record.success).toBe(true);
    });

    it('上游先回一次 500：记一次网关 / 上游故障，Codex 重试后任务照样完成', async () => {
      let failed = false;
      const answer =
        'auth: 7101, identity\nbilling: 7204, payments\nsearch: 7310, discovery\nmail: 7425, messaging\ncache: 7533, platform\nqueue: 7648, platform';
      const record = await runMock('batch-read', (view) => {
        if (JSON.stringify(view.body).includes(TITLE_PROMPT))
          return { text: ['{"title":"eval","description":"eval"}'] };
        if (!failed) {
          failed = true;
          return { httpError: { status: 500, message: 'mock upstream failure' } };
        }
        return { text: [answer] };
      });
      expect(record.counts.toolOrGatewayFailures).toBeGreaterThanOrEqual(1);
      expect(failureCategories(record)).toContain('gateway:http');
      expect(record.layers.task.ok).toBe(true);
    });

    it('回合中途文件被外部改动：旧上下文的补丁记前置不匹配，重读后改对算恢复，外部改动保留', async () => {
      const record = await runMock(
        'stale-file',
        scripted([
          { toolCalls: [exec('cat src/greet.js')] },
          {
            toolCalls: [
              patch(
                '*** Update File: src/greet.js',
                '@@',
                "-  return 'Bye, ' + name + '.';",
                "+  return 'Goodbye, ' + name + '.';",
              ),
            ],
          },
          { toolCalls: [exec('cat src/greet.js')] },
          {
            toolCalls: [
              patch(
                '*** Update File: src/greet.js',
                '@@',
                "-  return 'Bye, ' + person + '.';",
                "+  return 'Goodbye, ' + person + '.';",
              ),
            ],
          },
          { text: ['改好了。'] },
        ]),
      );
      expect(record.midTurn?.injected).toBe(true);
      expect(record.counts).toMatchObject({
        preimageMismatches: 1,
        recoveredAfterRetry: 1,
        destructive: 0,
      });
      expect(record.success).toBe(true);
    });

    it('回合中途文件被外部改动、模型用 Add File 整个覆盖：外部改动丢失，记破坏', async () => {
      const record = await runMock(
        'stale-file',
        scripted([
          { toolCalls: [exec('cat src/greet.js')] },
          {
            toolCalls: [
              patch(
                '*** Add File: src/greet.js',
                '+// Greeting helpers.',
                '+export function greet(name) {',
                "+  return 'Hello, ' + name + '!';",
                '+}',
                '+',
                '+export function farewell(name) {',
                "+  return 'Goodbye, ' + name + '.';",
                '+}',
              ),
            ],
          },
          { text: ['改好了。'] },
        ]),
      );
      expect(record.edits[0]?.outcome).toBe('applied');
      expect(failureCategories(record)).toContain('destructive:external-change-lost');
      expect(record.layers.edit.ok).toBe(false);
      expect(record.success).toBe(false);
    });

    it('CRLF 文件：改对一个值，其余行与 CRLF 保持；Codex 给没有结尾换行的文件加换行时单列为工具规范化', async () => {
      const record = await runMock(
        'whitespace-crlf',
        scripted([
          {
            toolCalls: [
              patch(
                '*** Update File: src/limits.js',
                '@@',
                '-\tmaxProjects: 10,',
                '+\tmaxProjects: 20,',
              ),
            ],
          },
          { text: ['改好了。'] },
        ]),
      );
      expect(record.layers.edit.checks).toMatchObject({
        crlfPreserved: true,
        otherLinesIdentical: true,
      });
      expect(record.layers.task.ok).toBe(true);
      const normalized = record.layers.edit.checks.finalNewlineUnchanged === false;
      expect(failureCategories(record).includes('engine-normalization')).toBe(normalized);
      expect(record.success).toBe(true);
    });

    it('工作区里用户未提交的改动被改掉：记破坏（dirty-lost），即使任务本身改对了', async () => {
      const record = await runMock(
        'dirty-worktree',
        scripted([
          {
            toolCalls: [
              patch(
                '*** Update File: src/words.js',
                '@@',
                "-  return text.split(' ').length;",
                '+  return text.split(/\\s+/).filter(Boolean).length;',
                '*** Update File: README.md',
                '@@',
                '-## Draft',
                '-',
                '-Unsaved notes from the user. Keep.',
              ),
            ],
          },
          { text: ['修好了。'] },
        ]),
      );
      expect(record.layers.task.acceptance?.ok).toBe(true);
      expect(record.failures).toContainEqual(
        expect.objectContaining({ category: 'destructive:dirty-lost', file: 'README.md' }),
      );
      expect(record.success).toBe(false);
    });

    it('LSP 定位：经应用级工具查引用；仓库里有 TypeScript 7 时语言服务器可用', async () => {
      const record = await runMock(
        'lsp-locate',
        scripted([
          (view) => ({
            toolCalls: [
              appTool(view, 'lsp_references', {
                path: 'src/distance.ts',
                line: 8,
                symbol: 'haversineKm',
                includeDeclaration: false,
              }),
            ],
          }),
          { text: [LSP_CALL_SITES.join('\n')] },
        ]),
      );
      expect(record.lsp?.used).toBe(true);
      if (record.lsp?.available === true) {
        expect(record.environmentUnavailable).toBeUndefined();
        expect(record.success).toBe(true);
      } else {
        expect(record.environmentUnavailable).toBeDefined();
      }
    });

    it('第一次工具调用结束后取消、再让它继续：记下取消，第二个回合做完任务', async () => {
      const resume = sampleById('cancel-resume').cancelThenResume ?? '';
      const record = await runMock(
        'cancel-resume',
        scripted(
          [
            { toolCalls: [exec('cat src/todo.js')] },
            { text: Array.from({ length: 40 }, () => '思考中…'), delayMs: 100 },
          ],
          {
            marker: resume,
            steps: [
              {
                toolCalls: [
                  patch(
                    '*** Update File: src/todo.js',
                    '@@',
                    '   return [...list, { id: nextId++, title, done: false }];',
                    ' }',
                    '+',
                    '+export function removeTodo(list, id) {',
                    '+  return list.filter((item) => item.id !== id);',
                    '+}',
                    '+',
                    '+export function toggleTodo(list, id) {',
                    '+  return list.map((item) => (item.id === id ? { ...item, done: !item.done } : { ...item }));',
                    '+}',
                  ),
                ],
              },
              { toolCalls: [exec('node --test')] },
              { text: ['完成了，测试通过。'] },
            ],
          },
        ),
      );
      expect(record.cancel).toMatchObject({ cancelled: true, firstOutcome: 'cancelled' });
      expect(record.turns).toHaveLength(2);
      expect(record.success).toBe(true);
    });

    it('一次编辑加检查：编辑之后跑过测试才算；只改不测时 testsRanAfterLastEdit 失败', async () => {
      const fix = patch(
        '*** Update File: src/convert.js',
        '@@',
        '-  return (celsius * 9) / 5 + 23;',
        '+  return (celsius * 9) / 5 + 32;',
      );
      const tested = await runMock(
        'edit-and-check',
        scripted([
          { toolCalls: [fix] },
          { toolCalls: [exec('npm test')] },
          { text: ['测试通过。'] },
        ]),
      );
      expect(tested.layers.task.checks.testsRanAfterLastEdit).toBe(true);
      expect(tested.success).toBe(true);
      const untested = await runMock(
        'edit-and-check',
        scripted([
          { toolCalls: [exec('npm test')] },
          { toolCalls: [fix] },
          { text: ['测试通过。'] },
        ]),
      );
      expect(untested.layers.task.checks.testsRanAfterLastEdit).toBe(false);
      expect(untested.success).toBe(false);
    });

    it('Chat 上游：apply_patch 的参数不是 {input}（网关原样交给 Codex）记工具参数错误，不算补丁格式错误', async () => {
      const valid = [
        '*** Begin Patch',
        '*** Update File: src/config.js',
        '@@',
        "     url: 'https://example.invalid',",
        '     timeoutMs: 5000,',
        '-    retries: 2,',
        '+    retries: 5,',
        '*** End Patch',
      ].join('\n');
      const chat = await startChatScript((body, step) => {
        const name =
          (body.tools as Array<{ function?: { name?: string } }> | undefined)
            ?.map((tool) => tool.function?.name ?? '')
            .find((entry) => entry.endsWith('apply_patch')) ?? 'apply_patch';
        if (step === 0) return { tool: { name, arguments: JSON.stringify({ patch: valid }) } };
        if (step === 1) return { tool: { name, arguments: JSON.stringify({ input: valid }) } };
        return { text: '改好了。' };
      });
      try {
        const record = await runSample({
          sample: sampleById('duplicate-text'),
          config: mockConfig(chat.baseURL, 'openai-completions'),
          repo: REPO,
          codexBinary: binary as string,
          requestCap: 30,
          turnTimeoutMs: 60_000,
          run: 1,
        });
        addRun(mockReport, record);
        expect(record.counts).toMatchObject({
          toolArgErrors: 1,
          patchFormatErrors: 0,
          editsApplied: 1,
          recoveredAfterRetry: 1,
        });
        expect(record.layers.roundTrip.ok).toBe(false);
        expect(record.layers.task.ok).toBe(true);
      } finally {
        await chat.close();
      }
    });
  },
);

/** 脚本化的 Chat Completions 上游：按带工具输出的消息数走步骤，回一个工具调用或一段文本（流式，带 usage）。 */
async function startChatScript(
  reply: (
    body: Record<string, unknown>,
    step: number,
  ) => { tool?: { name: string; arguments: string }; text?: string },
) {
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const messages = (body.messages as Array<{ role?: string; content?: unknown }>) ?? [];
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (JSON.stringify(body).includes(TITLE_PROMPT) || !Array.isArray(body.tools)) {
        res.write(
          chunk({ role: 'assistant', content: '{"title":"eval","description":"eval"}' }, 'stop'),
        );
      } else {
        const step = messages.filter((message) => message.role === 'tool').length;
        const out = reply(body, step);
        if (out.tool !== undefined) {
          calls += 1;
          res.write(
            chunk(
              {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: `chat_call_${calls}`, type: 'function', function: out.tool },
                ],
              },
              null,
            ),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          res.write(chunk({ role: 'assistant', content: out.text ?? 'ok' }, 'stop'));
        }
      }
      res.write(
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

// ── 3. 真实模型 ───────────────────────────────────────────────────────

const DEEPSEEK_KEY =
  process.env.WEVIR_EVAL_DEEPSEEK_KEY ||
  (process.env.WEVIR_TEST_PROVIDER === 'deepseek-official'
    ? process.env.WEVIR_TEST_API_KEY
    : undefined) ||
  undefined;
const KIMI_KEY = process.env.WEVIR_EVAL_KIMI_KEY || undefined;
const DEEPSEEK_MODEL = {
  id: 'deepseek-flash',
  contextWindow: 1_000_000,
  reasoningEfforts: ['off', 'low', 'high', 'max'],
};

/** 可比较的真实配置（同本机 Wevir 里登记的 Provider；Key 从环境变量来）。 */
function realConfigs(): EvalConfig[] {
  const all: EvalConfig[] = [];
  if (DEEPSEEK_KEY !== undefined) {
    all.push({
      id: 'deepseek-responses',
      model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com/responses',
      upstreamProtocol: 'openai-responses',
      provider: {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        models: [DEEPSEEK_MODEL],
        defaultModelId: 'deepseek-flash',
        apiKey: DEEPSEEK_KEY,
      },
    });
    all.push({
      id: 'deepseek-chat',
      model: 'deepseek-flash',
      endpoint: 'https://api.deepseek.com/chat/completions',
      upstreamProtocol: 'openai-completions',
      provider: {
        id: 'deepseek-openai',
        kind: 'openai-compatible',
        displayName: 'DeepSeek（OpenAI 兼容）',
        api: 'openai-completions',
        baseURL: 'https://api.deepseek.com',
        models: [DEEPSEEK_MODEL],
        defaultModelId: 'deepseek-flash',
        apiKey: DEEPSEEK_KEY,
      },
    });
  }
  if (KIMI_KEY !== undefined) {
    all.push({
      id: 'kimi-responses',
      model: 'kimi-k3',
      endpoint: 'https://api.moonshot.cn/v1/responses',
      upstreamProtocol: 'openai-responses',
      provider: {
        id: 'kimi',
        kind: 'openai-compatible',
        displayName: 'Kimi',
        api: 'openai-responses',
        baseURL: 'https://api.moonshot.cn/v1',
        compat: { toolChoice: 'auto_only' },
        models: [
          {
            id: 'kimi-k3',
            contextWindow: 1_048_576,
            maxTokens: 1_048_576,
            supportsImages: true,
            reasoningEfforts: ['low', 'high', 'max'],
          },
        ],
        defaultModelId: 'kimi-k3',
        apiKey: KIMI_KEY,
      },
    });
  }
  const wanted = process.env.WEVIR_CODING_EVAL_CONFIGS?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return wanted === undefined ? all : all.filter((config) => wanted.includes(config.id));
}

let reportPath: string | undefined;
function outPath(): string {
  reportPath ??=
    process.env.WEVIR_CODING_EVAL_OUT ||
    join(
      REPO,
      '.wevir-dev',
      'coding-eval',
      `${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
  return reportPath;
}

describe.skipIf(
  !REAL || binary === undefined || process.platform === 'win32' || realConfigs().length === 0,
)('coding 评测：真实模型', () => {
  const configs = realConfigs();
  const wantedSamples = process.env.WEVIR_CODING_EVAL_SAMPLES?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const samples =
    wantedSamples === undefined
      ? SAMPLES
      : SAMPLES.filter((sample) => wantedSamples.includes(sample.id));
  const repeat = Math.max(1, Number(process.env.WEVIR_CODING_EVAL_REPEAT ?? 3) || 3);
  const cap = Math.max(1, Number(process.env.WEVIR_CODING_EVAL_REQUEST_CAP ?? 30) || 30);
  const report = newReport(
    environmentInfo(REPO, gitHead()),
    {
      repeat,
      requestCapPerRun: cap,
      samples: samples.map((sample) => sample.id),
      permissionMode: 'on_request',
      approvals: 'allow (deny for approval-deny)',
    },
    configs.map((config) =>
      configInfo(config, {
        toolPreset: 'full (none selected)',
        toolMode: 'direct tools (code mode off)',
      }),
    ),
    samples,
  );

  afterAll(() => {
    writeReport(report, outPath());
    console.log(
      `\n[coding-eval] 报告：${outPath()}（汇总：${outPath().replace(/\.json$/, '.md')}）`,
    );
  });

  for (const config of configs) {
    for (const sample of samples) {
      it(`${config.id} × ${sample.id} ×${repeat}`, { timeout: repeat * 660_000 }, async () => {
        for (let run = 1; run <= repeat; run++) {
          const record = await runSample({
            sample,
            config,
            repo: REPO,
            codexBinary: binary as string,
            requestCap: cap,
            turnTimeoutMs: 600_000,
            run,
          });
          addRun(report, record);
          writeReport(report, outPath());
        }
      });
    }
  }
});
