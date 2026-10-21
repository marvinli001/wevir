import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, GuardrailBlockedEvent } from '@wevir/runtime-adapter';
import {
  guardrailChecker,
  guardrailHooks,
  writeGuardrailChecker,
} from '@wevir/runtime-adapter/guardrail';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { codexHookKey } from './hooks.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  ofType,
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

// 护栏（codex-event-mapping.md §6.17）：Host 的检查程序作为 SessionFlags 层的 hook 挂上，真实 Codex + 模拟模型。
// 仓库自带的 hooks（`.codex/hooks.json`）不执行，`disabledHooks` 再显式停用一次。

const binary = codexBinaryOrSkip('guardrails');
const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
let mock: MockModel;

/** 结束前检查给 Agent 的理由（hookPrompt）出现了几次。 */
function stopPrompts(view: MockView): number {
  return JSON.stringify(view.body.input).split('requires the check').length - 1;
}

function script(view: MockView) {
  const prompt = view.lastUserText;
  if (prompt.startsWith('forbidden')) {
    return view.toolOutputs.length === 0
      ? {
          toolCalls: [
            { kind: 'function' as const, name: 'exec_command', args: { cmd: 'rm -rf build' } },
          ],
        }
      : { text: [`done: ${view.toolOutputs.join(' | ')}`] };
  }
  if (prompt.startsWith('fix')) {
    // 第一次直接说做完；被结束前检查拦回来后建出 ok.txt 再说做完。
    if (stopPrompts(view) === 0) return { text: ['finished'] };
    const ran = JSON.stringify(view.body.input).includes('touch ok.txt');
    return ran
      ? { text: ['fixed'] }
      : {
          toolCalls: [
            { kind: 'function' as const, name: 'exec_command', args: { cmd: 'touch ok.txt' } },
          ],
        };
  }
  return { text: [`reply ${stopPrompts(view)}`] };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'w',
      GIT_AUTHOR_EMAIL: 'w@example.com',
      GIT_COMMITTER_NAME: 'w',
      GIT_COMMITTER_EMAIL: 'w@example.com',
    },
  });
}

/** 一个装好检查程序、写好全局规则的数据目录，加一个 git 工作区。 */
function setup(label: string, guardrails: Array<{ id: string; rule: Record<string, unknown> }>) {
  const { root, home, workspace } = dirs.make(label);
  git(workspace, 'init', '-q', '-b', 'main');
  const checker = guardrailChecker(join(home, 'guardrails'));
  writeGuardrailChecker(checker);
  writeFileSync(
    join(checker.dir, 'global.json'),
    JSON.stringify({ version: 1, guardrails: guardrails.map((g) => ({ ...g, enabled: true })) }),
  );
  const hooks = guardrailHooks(
    checker,
    undefined,
    guardrails.map((g) => ({ kind: g.rule.kind as 'forbidden_command' })),
  );
  return { root, home, workspace, hooks };
}

async function start(home: string, workspace: string, extra: Record<string, unknown>) {
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    ...extra,
  });
  return { adapter, engineSessionId, events: collectEvents(adapter, engineSessionId) };
}

const blocked = (turn: AgentEvent[]): GuardrailBlockedEvent[] =>
  turn.filter(ofType('guardrail.blocked'));

describe.skipIf(binary === undefined)('CodexAdapter guardrails', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    mock = await startMockModel(script);
  });
  afterAll(async () => {
    await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
    await mock?.close();
    dirs.cleanup();
  });

  it('blocks a forbidden command and tells the model why; repo hooks do not run', async () => {
    const { root, home, workspace, hooks } = setup('forbidden', [
      { id: 'grd_rm', rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' } },
    ]);
    // 仓库自带的 hook：不信任，不执行；再用 disabledHooks 显式停用。
    const marker = join(root, 'repo-hook-ran');
    mkdirSync(join(workspace, '.codex'));
    const repoHooks = join(workspace, '.codex', 'hooks.json');
    writeFileSync(
      repoHooks,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: `touch '${marker}'` }] },
          ],
        },
      }),
    );
    mkdirSync(join(workspace, 'build'));
    writeFileSync(join(workspace, 'build', 'keep.txt'), 'keep');
    const { adapter, engineSessionId, events } = await start(home, workspace, {
      hooks,
      disabledHooks: [codexHookKey(repoHooks, 'PreToolUse', 0, 0)],
    });

    const turn = await runTurn(adapter, engineSessionId, 'forbidden', events);

    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    const [hit, ...rest] = blocked(turn);
    expect(rest).toEqual([]);
    expect(hit).toMatchObject({
      guardrailId: 'grd_rm',
      kind: 'forbidden_command',
      action: 'denied',
      tool: 'Bash',
      command: 'rm -rf build',
    });
    expect(hit?.reason).toContain('forbidden command "rm -rf"');
    expect(existsSync(join(workspace, 'build', 'keep.txt'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    const last = mock.requests.at(-1)?.body.input ?? [];
    expect(JSON.stringify(last)).toContain('Blocked by a Wevir guardrail');
  });

  it('a failing stop check makes the agent continue until the check passes', async () => {
    const { home, workspace, hooks } = setup('stop', [
      { id: 'grd_ok', rule: { kind: 'stop_check', command: 'test -f ok.txt', timeoutSec: 30 } },
    ]);
    const { adapter, engineSessionId, events } = await start(home, workspace, { hooks });

    const turn = await runTurn(adapter, engineSessionId, 'fix', events);

    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(blocked(turn)).toEqual([
      expect.objectContaining({
        guardrailId: 'grd_ok',
        kind: 'stop_check',
        action: 'continued',
        attempt: 1,
        maxAttempts: 3,
      }),
    ]);
    expect(existsSync(join(workspace, 'ok.txt'))).toBe(true);
  });

  it('lets the turn finish after the attempt cap', async () => {
    const { home, workspace, hooks } = setup('cap', [
      {
        id: 'grd_no',
        rule: { kind: 'stop_check', command: 'exit 1', maxAttempts: 2, timeoutSec: 30 },
      },
    ]);
    const { adapter, engineSessionId, events } = await start(home, workspace, { hooks });

    const turn = await runTurn(adapter, engineSessionId, 'cap', events);

    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    expect(blocked(turn).map((event) => [event.action, event.attempt])).toEqual([
      ['continued', 1],
      ['continued', 2],
      ['allowed', 2],
    ]);
    // 新回合重新计数。
    const next = await runTurn(adapter, engineSessionId, 'again', events);
    expect(blocked(next)[0]).toMatchObject({ action: 'continued', attempt: 1 });
  });
});
