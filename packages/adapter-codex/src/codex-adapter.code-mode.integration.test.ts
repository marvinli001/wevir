// Code mode：真实 codex-app-server + 网关 + mock 模型。只给 code mode 的模型（ChatGPT 的部分模型由模型目录的
// `tool_mode` 指定，这里用 `features.code_mode_only` 模拟）只有 `exec` 等几个工具，`exec` 的 JS 在独立的
// codex-code-mode-host 进程里跑，codex-app-server 在自己旁边找它（scripts/fetch-codex.sh 一起下载）。没有它时模型
// 调不了任何工具，只拿到 “failed to spawn code-mode host”。二进制不在时跳过。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockView,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex code mode');
const dirs = new TempDirs();
let mock: MockModel;
const views: MockView[] = [];

describe.skipIf(binary === undefined)(
  'CodexAdapter code mode（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    let adapter: CodexAdapter | undefined;
    beforeAll(async () => {
      mock = await startMockModel((view) => {
        views.push(view);
        if (view.toolOutputs.length > 0) return { text: ['好了。'] };
        return {
          toolCalls: [
            {
              kind: 'custom',
              name: 'exec',
              input:
                'text(JSON.stringify(await tools.exec_command({ cmd: "printf code_mode_marker" })));',
            },
          ],
        };
      });
    });
    afterAll(async () => {
      await adapter?.dispose();
      await mock?.close();
      dirs.cleanup();
    });

    it('exec 在 codex-code-mode-host 里跑，嵌套的 exec_command 执行并返回输出', async () => {
      const { home, workspace } = dirs.make('code-mode');
      adapter = newAdapter({
        home,
        binaryArgs: ['-c', 'features.code_mode_only=true'],
        providers: [mockProvider(mock)],
      });
      const { engineSessionId } = await adapter.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      const events = collectEvents(adapter, engineSessionId);
      const turn = await runTurn(adapter, engineSessionId, '列出文件', events);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(views[0]?.body.tools?.map((tool) => tool.name)).toContain('exec');
      const output = views[1]?.toolOutputs.join('\n') ?? '';
      expect(output).not.toContain('failed to spawn code-mode host');
      expect(output).toContain('code_mode_marker');
    });
  },
);
