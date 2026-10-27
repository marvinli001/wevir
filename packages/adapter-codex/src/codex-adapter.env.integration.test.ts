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

// 环境的变量（0.130.0，codex-event-mapping.md §6.19）：`thread/start` 的 `shell_environment_policy.set` 交给模型跑的命令，真实
// Codex + 模拟模型。名字带 KEY 的变量也要到得了（Codex 的默认排除在 `set` 之前）。

const binary = codexBinaryOrSkip('session env');
const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
let mock: MockModel;

/** 模型跑的命令：打印两个变量。PowerShell 里带引号的路径要用调用符 `&` 才算命令，sh 不认它。 */
const PRINT_ENV = `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" -e "process.stdout.write('[' + (process.env.STRIPE_SECRET_KEY ?? 'unset') + '|' + (process.env.API_BASE ?? 'unset') + ']')"`;

function script(view: MockView) {
  return view.toolOutputs.length === 0
    ? { toolCalls: [{ kind: 'function' as const, name: 'exec_command', args: { cmd: PRINT_ENV } }] }
    : { text: [`done: ${view.toolOutputs.join(' | ')}`] };
}

async function run(label: string, env: Record<string, string> | undefined): Promise<string> {
  const { home, workspace } = dirs.make(label);
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    ...(env !== undefined && { env }),
  });
  const turn = await runTurn(
    adapter,
    engineSessionId,
    'env',
    collectEvents(adapter, engineSessionId),
  );
  expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
  return JSON.stringify(mock.requests.at(-1)?.body.input ?? []);
}

describe.skipIf(binary === undefined)('CodexAdapter session env', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    mock = await startMockModel(script);
  });
  afterAll(async () => {
    await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
    await mock?.close();
    dirs.cleanup();
  });

  it("the model's commands see the environment's variables, including names with KEY", async () => {
    const output = await run('with', {
      STRIPE_SECRET_KEY: 'sk_test_51envcheck',
      API_BASE: 'http://localhost:3000',
    });
    expect(output).toContain('[sk_test_51envcheck|http://localhost:3000]');
  });

  it('a session without variables does not get them', async () => {
    expect(await run('without', undefined)).toContain('[unset|unset]');
  });
});
