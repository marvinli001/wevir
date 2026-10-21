// 后台进程与大输出落盘（0.47.0）：只带 Codex 引擎的 Host（startHost + 真实 codex-app-server + mock 模型）。mock 模型在第一个
// 回合用 wevir_process_start 起一个进程并等到它就绪，回合结束；进程之后自己退出，Host 把通知作为消息发回会话、开第二个回合，
// 模型在里面读 1000 行输出，结果超过 8000 字节被落盘，模型拿到的是路径与开头结尾。请求批准时只有起进程问一次。没有
// codex-app-server 时跳过。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRuntime, resolveCodexBinary } from '@wevir/adapter-codex';
import {
  MOCK_MODEL,
  type MockRequestBody,
  type MockScript,
  startMockModel,
} from '@wevir/adapter-codex/testing';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[后台进程 + codex] 跳过：${(error as Error).message}`);
    return false;
  }
}

function wevirTool(tools: MockRequestBody['tools'], name: string) {
  for (const tool of tools ?? []) {
    if (tool.type === 'namespace') {
      const inner = ((tool.tools ?? []) as Array<{ name?: string }>).find((t) => t.name === name);
      if (inner?.name) return { name: inner.name, namespace: tool.name as string };
    } else if (tool.name?.endsWith(name)) {
      return { name: tool.name };
    }
  }
  throw new Error(`请求里没有 ${name}`);
}

const call = (body: MockRequestBody, name: string, args: unknown) => {
  const tool = wevirTool(body.tools, name);
  return {
    toolCalls: [
      {
        kind: 'function' as const,
        name: tool.name,
        ...(tool.namespace !== undefined && { namespace: tool.namespace }),
        args,
      },
    ],
  };
};

function outputText(output: string | undefined): string {
  try {
    const items = JSON.parse(output ?? '') as Array<{ text?: string }>;
    if (Array.isArray(items)) return items.map((item) => item.text ?? '').join('\n');
  } catch {
    // 本来就是文本
  }
  return output ?? '';
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

/** 模型在每个工具结果里实际看到的文本（第二个回合的检查用）。 */
const seen: string[] = [];

const script: MockScript = (view) => {
  // 进程退出的通知经 <relayed_message> 包着发来，开头是 `<`，mock 的 lastUserText 会跳过它：靠整条消息的开头认出第二个回合
  // （标题与建议的请求把整段对话放进 <conversation>，里面也有这几个字，但开头不同）。
  const input = view.body.input;
  const notified = input.findIndex(
    (item) =>
      item.type === 'message' &&
      item.role === 'user' &&
      messageText(item.content).startsWith('<relayed_message') &&
      messageText(item.content).includes('Background process'),
  );
  if (notified >= 0) {
    const outputs = input
      .slice(notified + 1)
      .filter((item) => item.type === 'function_call_output')
      .map((item) =>
        outputText(typeof item.output === 'string' ? item.output : JSON.stringify(item.output)),
      );
    if (outputs.length === 0)
      return call(view.body, 'wevir_process_output', { id: 'p1', lines: 1000 });
    seen.push(...outputs);
    return { text: ['read the log'] };
  }
  const outputs = view.toolOutputs.map(outputText);
  if (view.lastUserText.includes('[proc]')) {
    if (outputs.length === 0) {
      return call(view.body, 'wevir_process_start', {
        command:
          'echo "ready on 5173"; sleep 1; i=1; while [ $i -le 3000 ]; do echo "row $i"; i=$((i+1)); done; exit 4',
        name: 'dev server',
        waitFor: 'ready on',
      });
    }
    return { text: [`started: ${outputs[0] ?? ''}`] };
  }
  return { text: ['你好。'] };
};

describe.skipIf(!binaryAvailable())(
  '后台进程（startHost + 真实 codex-app-server + mock 模型）',
  { timeout: 120_000 },
  () => {
    it('请求批准：起进程问一次；退出通知开新回合；大输出落盘后模型拿到路径', async () => {
      seen.length = 0;
      const model = await startMockModel(script);
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      const workspace = join(tempDir(), 'workspace');
      mkdirSync(workspace);
      const host = await startHost({
        home,
        adapter: new CodexRuntime({
          home,
          binary: resolveCodexBinary(),
          clientInfo: { name: 'wevir', version: '0.0.0' },
        }),
        engine: 'codex',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      });
      cleanups.push(() => host.shutdown());
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(host.url);
      cleanups.push(() => client.ws.close());
      await client.hello(info.token as string);
      const { workspace: ws } = await client.request('workspace.add', { rootPath: workspace });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });
      const { session } = await client.request('session.create', {
        workspaceId: ws.id,
        providerId: 'wevir-mock',
        permissionMode: 'on_request',
      });
      const sessionId = session.id as SessionId;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const asked: string[] = [];
      const answered = new Set<string>();
      const finishedTurns = () =>
        client.until(
          () => {
            const events = client.events(subscriptionId);
            for (const event of events) {
              if (event.type !== 'approval.requested' || answered.has(event.payload.approval.id))
                continue;
              answered.add(event.payload.approval.id);
              asked.push(event.payload.approval.detail?.toolName ?? '');
              const optionId = event.payload.approval.options.find(
                (option) => option.category === 'allow',
              )?.optionId;
              void client.request('approval.respond', {
                approvalId: event.payload.approval.id,
                optionId,
              });
            }
            const finished = events.filter((e) => e.type === 'turn.finished');
            return finished.length >= 2 ? finished : undefined;
          },
          'two turns',
          90_000,
        );
      await client.request('session.send', {
        sessionId,
        content: [{ type: 'text', text: '[proc] 起开发服务器' }],
      });
      await finishedTurns();
      const events: WevirEvent[] = client.events(subscriptionId);

      expect(asked).toEqual(['mcp__wevir__wevir_process_start']);
      const answers = events.flatMap((e) =>
        e.type === 'assistant.message' ? [(e.payload as { text: string }).text] : [],
      );
      expect(answers[0]).toMatch(
        /^started: [\s\S]*Started p1 "dev server"[\s\S]*Matched \/ready on\//,
      );
      const notice = events.find(
        (e) => e.type === 'user.message' && e.payload.from?.process !== undefined,
      );
      expect(notice?.payload).toMatchObject({
        from: {
          sessionId,
          kind: 'report',
          process: { id: 'p1', name: 'dev server', event: 'exit', exitCode: 4 },
        },
      });
      expect(answers.at(-1)).toBe('read the log');

      const output = seen[0] ?? '';
      expect(output).toContain('too large to show here, so Wevir saved it to:');
      expect(Buffer.byteLength(output)).toBeLessThan(10_000);
      // Codex 在 MCP 结果前加一行 “Wall time: …”。
      const path = /saved it to:\n(.+)/.exec(output)?.[1] as string;
      expect(path.startsWith(join(home, 'tool-output', sessionId))).toBe(true);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('row 2500\n');
      expect(output).toContain('row 3000');
    });
  },
);
