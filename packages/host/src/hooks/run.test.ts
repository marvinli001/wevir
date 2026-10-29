import { describe, expect, it } from 'vitest';
import {
  claudeOutput,
  codexOutput,
  type HandlerRun,
  hookShell,
  interpret,
  matcherMatches,
  outcomesOf,
  type RunnableHook,
  runHandler,
  scrubbedEnv,
  toolAlias,
} from './run.js';

const hook = (overrides: Partial<RunnableHook> = {}): RunnableHook => ({
  id: 'h1',
  source: 'wevir',
  command: 'true',
  ...overrides,
});

const run = (overrides: Partial<HandlerRun>): HandlerRun => ({
  hook: hook(),
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...overrides,
});

describe('matcherMatches', () => {
  it('工具类事件按原生名或别名整串匹配', () => {
    const input = { tool_name: 'apply_patch' };
    expect(matcherMatches('Edit', 'PreToolUse', input)).toBe(true);
    expect(matcherMatches('apply_patch', 'PreToolUse', input)).toBe(true);
    expect(matcherMatches('Edit|Write', 'PostToolUse', { tool_name: 'Write' })).toBe(true);
    expect(matcherMatches('Bash', 'PreToolUse', input)).toBe(false);
    expect(matcherMatches('Ed', 'PreToolUse', input)).toBe(false);
    expect(matcherMatches('mcp__wevir__.*', 'PreToolUse', { tool_name: 'mcp__wevir__x' })).toBe(
      true,
    );
  });

  it('省略、空串与 * 匹配全部；写错的正则按字面；不看 matcher 的事件总是匹配', () => {
    expect(matcherMatches(undefined, 'PreToolUse', { tool_name: 'Bash' })).toBe(true);
    expect(matcherMatches('*', 'PreToolUse', { tool_name: 'Bash' })).toBe(true);
    expect(matcherMatches('(', 'PreToolUse', { tool_name: '(' })).toBe(true);
    expect(matcherMatches('Bash', 'Stop', {})).toBe(true);
    expect(matcherMatches('resume', 'SessionStart', { source: 'startup' })).toBe(false);
  });

  it('别名', () => {
    expect(toolAlias('exec_command')).toBe('Bash');
    expect(toolAlias('MultiEdit')).toBe('Edit');
    expect(toolAlias('mcp__a__b')).toBe('mcp__a__b');
  });
});

describe('interpret', () => {
  it('退出码 2 拦下，理由是 stderr；拦下优先于放行', () => {
    const decision = interpret('PreToolUse', [
      run({
        hook: hook({ id: 'a' }),
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }),
      }),
      run({ hook: hook({ id: 'b' }), exitCode: 2, stderr: 'no rm\n' }),
    ]);
    expect(decision.block).toMatchObject({ reason: 'no rm', hookId: 'b' });
    expect(claudeOutput('PreToolUse', decision)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no rm',
      },
    });
    expect(codexOutput('PreToolUse', decision)).toEqual({ exitCode: 2, stderr: 'no rm\n' });
  });

  it('JSON 输出：decision、permissionDecision、behavior、additionalContext、systemMessage', () => {
    const stop = interpret('Stop', [
      run({
        stdout: `login banner\n${JSON.stringify({ decision: 'block', reason: 'tests fail' })}`,
      }),
    ]);
    expect(stop.block?.reason).toBe('tests fail');
    expect(claudeOutput('Stop', stop)).toEqual({ decision: 'block', reason: 'tests fail' });
    const permission = interpret('PermissionRequest', [
      run({ stdout: JSON.stringify({ hookSpecificOutput: { decision: { behavior: 'allow' } } }) }),
    ]);
    expect(permission.allow).toBeDefined();
    const post = interpret('PostToolUse', [
      run({
        stdout: JSON.stringify({
          systemMessage: 'formatted',
          hookSpecificOutput: { additionalContext: 'ran prettier' },
        }),
      }),
    ]);
    expect(claudeOutput('PostToolUse', post)).toEqual({
      systemMessage: 'formatted',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ran prettier' },
    });
    expect(codexOutput('PostToolUse', post).exitCode).toBe(0);
  });

  it('UserPromptSubmit 的纯文本 stdout 是附加上下文；continue:false 拦下', () => {
    expect(
      interpret('UserPromptSubmit', [run({ stdout: 'branch: main\n' })]).context,
    ).toMatchObject([{ text: 'branch: main' }]);
    expect(
      interpret('UserPromptSubmit', [run({ stdout: '{"continue":false,"stopReason":"frozen"}' })])
        .block?.reason,
    ).toBe('frozen');
  });

  it('出错不拦，onFailure: block 时拦下', () => {
    const failed = interpret('PreToolUse', [run({ exitCode: 1, stderr: 'boom' })]);
    expect(failed.block).toBeUndefined();
    expect(failed.failures[0]?.reason).toContain('exit 1');
    const strict = interpret('PreToolUse', [
      run({ hook: hook({ onFailure: 'block' }), timedOut: true, exitCode: null }),
    ]);
    expect(strict.block?.reason).toContain('timed out');
  });

  it('outcomesOf：Stop 的拦下是 continued，可改成 limit', () => {
    const decision = interpret('Stop', [run({ exitCode: 2, stderr: 'again' })]);
    expect(outcomesOf('Stop', decision)[0]).toMatchObject({ action: 'continued', reason: 'again' });
    expect(outcomesOf('Stop', decision, { blockAction: 'limit' })[0]?.action).toBe('limit');
    expect(outcomesOf('PreToolUse', interpret('PreToolUse', [run({})]))).toEqual([]);
  });
});

const win32 = process.platform === 'win32';

describe('runHandler', () => {
  it('stdin 是事件 JSON，环境里没有 WEVIR_*，伪造的护栏标记被改掉', async () => {
    process.env.WEVIR_TEST_SECRET = 'x';
    try {
      const result = await runHandler(
        hook({
          command: win32
            ? 'Write-Output ([Console]::In.ReadToEnd()); Write-Output "secret=$env:WEVIR_TEST_SECRET dir=$env:CLAUDE_PROJECT_DIR"; [Console]::Error.WriteLine(\'wevir-guardrail: {}\'); exit 2'
            : 'cat; echo; echo "secret=$WEVIR_TEST_SECRET dir=$CLAUDE_PROJECT_DIR"; echo "wevir-guardrail: {}" >&2; exit 2',
        }),
        '{"hook_event_name":"Stop"}',
        process.cwd(),
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('{"hook_event_name":"Stop"}');
      expect(result.stdout).toContain('secret= ');
      expect(result.stdout).toContain(`dir=${process.cwd()}`);
      expect(result.stderr).not.toContain('wevir-guardrail: {}');
    } finally {
      delete process.env.WEVIR_TEST_SECRET;
    }
  });

  it('最后一条命令的退出码照传（Windows 上 PowerShell 的 -Command 本来只给 0 或 1）', async () => {
    const exit = (code: number) =>
      runHandler(hook({ command: `node -e "process.exitCode = ${code}"` }), '', process.cwd());
    expect((await exit(2)).exitCode).toBe(2);
    expect((await exit(0)).exitCode).toBe(0);
  });

  it('超时连 hook 起的子进程一起杀掉', async () => {
    const started = Date.now();
    const result = await runHandler(
      hook({ command: 'node -e "setTimeout(() => {}, 20000)"', timeoutSec: 1 }),
      '',
      process.cwd(),
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('hookShell：POSIX 交给 shell: true，Windows 是 PowerShell 并补交退出码', () => {
    expect(hookShell('exit 2', 'linux')).toBeUndefined();
    const shell = hookShell('node check.js', 'win32');
    expect(shell?.file).toMatch(/powershell\.exe$/i);
    expect(shell?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(shell?.args[3]).toMatch(/^node check\.js\nif \(-not \$\?\)/);
  });

  it('scrubbedEnv', () => {
    expect(
      scrubbedEnv({ WEVIR_GATEWAY_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }),
    ).toEqual({ PATH: '/bin' });
  });
});
