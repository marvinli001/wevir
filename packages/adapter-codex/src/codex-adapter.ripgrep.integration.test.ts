import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 随包的 rg：codex-app-server 在上游的包布局里（bin/ 下、上一级有 codex-package.json）时，把 codex-path/ 放到模型所跑命令的 PATH
// 最前面，用户机器上没装 rg 也能搜索。WEVIR_CODEX_BIN 指向包外的二进制时没有这个目录，用例跳过。

const binary = codexBinaryOrSkip('adapter-codex 随包的 rg');
const packageDir = binary === undefined ? undefined : dirname(dirname(binary));
const bundledRg =
  packageDir === undefined
    ? undefined
    : join(packageDir, 'codex-path', process.platform === 'win32' ? 'rg.exe' : 'rg');
const inPackage = packageDir !== undefined && existsSync(join(packageDir, 'codex-package.json'));

const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['ok'] });

beforeAll(async () => {
  if (binary !== undefined) mock = await startMockModel((view) => script(view));
});
afterAll(async () => {
  await mock?.close();
  dirs.cleanup();
});

describe.skipIf(binary === undefined || !inPackage || process.platform === 'win32')(
  '随包的 rg',
  () => {
    it('模型跑的命令里 rg 是 codex-path/ 里的那份，不依赖用户机器上装没装', async () => {
      const { home, workspace } = dirs.make('ripgrep');
      const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
      try {
        script = (view) =>
          view.toolOutputs.length > 0
            ? { text: ['done'] }
            : {
                toolCalls: [
                  {
                    kind: 'function',
                    name: 'exec_command',
                    args: { cmd: 'command -v rg && rg --version' },
                  },
                ],
              };
        const { engineSessionId } = await adapter.createSession({
          cwd: workspace,
          providerId: 'mock',
          modelId: MOCK_MODEL,
        });
        const events = collectEvents(adapter, engineSessionId);
        const turn = await runTurn(adapter, engineSessionId, 'where is rg', events);
        const finished = turn.find((e) => e.type === 'tool.finished');
        const output = finished?.type === 'tool.finished' ? (finished.output ?? '') : '';
        expect(output.split('\n')[0]?.trim()).toBe(realpathSync(bundledRg ?? ''));
        expect(output).toMatch(/ripgrep \d+\.\d+\.\d+/);
      } finally {
        await adapter.dispose();
      }
    });
  },
);
