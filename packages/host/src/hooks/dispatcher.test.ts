import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookOutcome, SessionId, TurnId, WevirEvent, WorkspaceId } from '@wevir/protocol';
import { type GuardrailMarker, guardrailChecker } from '@wevir/runtime-adapter/guardrail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuardrailService } from '../guardrails/service.js';
import { HookDispatcher, type HookSessionInfo } from './dispatcher.js';
import { HookService } from './service.js';

const WS = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;
const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as TurnId;

let root: string;
let cwd: string;
let hooks: HookService;
let guardrails: GuardrailService;
let info: HookSessionInfo;
let outcomes: HookOutcome[];
let markers: GuardrailMarker[];
let continued: string[];
let server: Server | undefined;

function dispatcher(tap: 'codex' | 'callback' | undefined): HookDispatcher {
  const checker = guardrailChecker(join(root, 'guardrails'));
  const result = new HookDispatcher({
    service: hooks,
    engineOf: () => ({ engine: tap === 'callback' ? 'claude' : 'codex', ...(tap && { tap }) }),
    checker,
    guardrailKinds: (workspaceId) =>
      new Set(guardrails.list(workspaceId).map((guardrail) => guardrail.rule.kind)),
    tapDir: join(root, 'taps'),
    providers: () => [{ id: 'p', kind: 'openai' }],
  });
  result.bind({
    info: () => info,
    outcome: (_sessionId, outcome) => outcomes.push(outcome),
    guardrailBlocked: (_sessionId, marker) => markers.push(marker),
    continueTurn: async (_sessionId, text) => {
      continued.push(text);
      return { turnId: `trn_${continued.length}` as TurnId };
    },
  });
  return result;
}

const command = (cmd: string) => ({ type: 'command' as const, command: cmd });

let scripts = 0;
/**
 * 用 node 跑一段脚本的 hook（POSIX 的 sh 与 Windows 的 PowerShell 都认这条命令行）。`input` 是 stdin 的文本，`stderr(text)`
 * 写理由；退出码用 `process.exitCode` 设，免得输出还没写完进程就退了。
 */
function script(body: string) {
  scripts += 1;
  const file = join(root, `hook-${scripts}.mjs`);
  writeFileSync(
    file,
    `import { readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nconst stderr = (text) => process.stderr.write(text + '\\n');\n${body}\n`,
  );
  return command(`node "${file}"`);
}

/** 异步按 Codex 的方式跑 hook 命令行：POSIX 是 `sh -c`，Windows 是 PowerShell（同一进程里的 HTTP 服务要能回应）。 */
function sh(line: string, input: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-Command', line], { windowsHide: true })
        : spawn('/bin/sh', ['-c', line]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stderr: stderr.replaceAll('\r\n', '\n') }));
    child.stdin.end(input);
  });
}

// Windows 的 runner 上每个 hook 都经 PowerShell，冷启动要好几秒。
if (process.platform === 'win32') vi.setConfig({ testTimeout: 90_000 });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wevir-dispatch-'));
  cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  hooks = new HookService({
    dir: join(root, 'hooks'),
    workspaceRoot: () => cwd,
    scanTtlMs: 0,
  });
  guardrails = new GuardrailService({
    checker: guardrailChecker(join(root, 'guardrails')),
    workspaceRoot: () => cwd,
  });
  info = { providerId: 'p', cwd, workspaceId: WS, turnId: TURN };
  outcomes = [];
  markers = [];
  continued = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('HookDispatcher', () => {
  it('Claude 接点：hook 拦下 Bash，记 hook.outcome；没匹配上的事件是空输出', async () => {
    await hooks.add({
      workspaceId: WS,
      event: 'PreToolUse',
      matcher: 'Bash',
      handler: script(
        `if (input.includes('rm -rf')) { stderr('no rm -rf'); process.exitCode = 2; }`,
      ),
    });
    const tap = dispatcher('callback').claudeTap(SES);
    expect(
      await tap.run('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'no rm -rf',
      },
    });
    expect(outcomes).toEqual([
      expect.objectContaining({
        event: 'PreToolUse',
        action: 'blocked',
        tool: 'Bash',
        turnId: TURN,
      }),
    ]);
    expect(await tap.run('PreToolUse', { tool_name: 'Read', tool_input: {} })).toEqual({});
  });

  it('Claude 接点也执行护栏：禁止命令与 Claude 的改文件工具上的保护路径', async () => {
    await guardrails.add({
      workspaceId: WS,
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'git push' },
    });
    await guardrails.add({ workspaceId: WS, rule: { kind: 'protected_path', glob: '.env' } });
    const tap = dispatcher('callback').claudeTap(SES);
    const push = await tap.run('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    expect(push.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    const edit = await tap.run('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, '.env'), content: 'X=1' },
    });
    expect(edit.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(markers.map((marker) => [marker.kind, marker.action])).toEqual([
      ['forbidden_command', 'denied'],
      ['protected_path', 'denied'],
    ]);
  });

  it('Stop 要求继续，同一回合最多 3 次', async () => {
    await hooks.add({
      event: 'Stop',
      handler: script(`stderr('run the tests'); process.exitCode = 2;`),
    });
    const tap = dispatcher('callback').claudeTap(SES);
    for (let i = 0; i < 3; i += 1) {
      expect(await tap.run('Stop', {})).toEqual({ decision: 'block', reason: 'run the tests' });
    }
    expect(await tap.run('Stop', {})).toEqual({});
    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      'continued',
      'continued',
      'continued',
      'limit',
    ]);
  });

  it('Codex 接点：转发命令经 POST /hooks 回到 Host，拦下时退出码 2、理由在 stderr', async () => {
    await hooks.add({
      event: 'PreToolUse',
      handler: script(`stderr('blocked by policy'); process.exitCode = 2;`),
    });
    const hub = dispatcher('codex');
    server = createServer((req, res) => {
      if (!hub.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    hub.setPort((server.address() as AddressInfo).port);
    const engineHooks = hub.codexHooks(SES, info);
    expect(engineHooks.map((hook) => hook.event)).toEqual(['PreToolUse']);
    const forward = engineHooks[0]?.command ?? '';
    const result = await sh(
      forward,
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }),
    );
    expect(result).toEqual({ status: 2, stderr: 'blocked by policy\n' });
    expect(outcomes[0]).toMatchObject({ action: 'blocked', source: 'wevir' });
    // 会话关闭后令牌作废：转发不通时放行。
    hub.forget(SES);
    const after = await sh(forward, '{"hook_event_name":"PreToolUse"}');
    expect(after.status).toBe(0);
  });

  it('Host 派发：UserPromptSubmit 拦下或附加上下文，SessionStart 每个引擎会话一次', async () => {
    await hooks.add({
      event: 'UserPromptSubmit',
      handler: script(
        `if (input.includes('secret')) { stderr('no secrets'); process.exitCode = 2; } else console.log('on branch main');`,
      ),
    });
    await hooks.add({
      event: 'SessionStart',
      handler: script(`console.log('read NOTES.md first');`),
    });
    const hub = dispatcher(undefined);
    expect(await hub.userPromptSubmit(SES, 'print the secret')).toEqual({
      blocked: 'no secrets',
    });
    expect(await hub.userPromptSubmit(SES, 'hello')).toEqual({ context: 'on branch main' });
    expect(await hub.sessionStart(SES, 'startup')).toBe('read NOTES.md first');
    expect(await hub.sessionStart(SES, 'resume')).toBeUndefined();
    hub.restarted(SES);
    expect(await hub.sessionStart(SES, 'resume')).toBe('read NOTES.md first');
  });

  it('Host 派发：PermissionRequest 批准或拒绝；没有处理器时 undefined', async () => {
    const hub = dispatcher(undefined);
    expect(await hub.permissionRequest(SES, 'Bash', { command: 'ls' })).toBeUndefined();
    await hooks.add({
      event: 'PermissionRequest',
      matcher: 'Bash',
      handler: script(
        `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));`,
      ),
    });
    expect(await hub.permissionRequest(SES, 'Bash', { command: 'ls' })).toEqual({
      behavior: 'allow',
    });
    expect(await hub.permissionRequest(SES, 'apply_patch', {})).toBeUndefined();
  });

  it('没有原生接点：回合结束后 Host 跑 Stop，要求继续时开后续回合，这串回合合计最多 3 次', async () => {
    await hooks.add({
      event: 'Stop',
      handler: script(`stderr('not done'); process.exitCode = 2;`),
    });
    const hub = dispatcher(undefined);
    const finished = (turnId: string): WevirEvent =>
      ({
        type: 'turn.finished',
        sessionId: SES,
        seq: 1,
        ts: new Date().toISOString(),
        source: 'host',
        payload: { turnId, outcome: 'completed', durationMs: 1 },
      }) as WevirEvent;
    // 每个回合结束都等它的 Stop 记下结果再发下一个。
    const settle = (count: number) =>
      vi.waitFor(() => expect(outcomes).toHaveLength(count), { timeout: 20_000, interval: 20 });
    hub.onEvent(finished(TURN));
    await settle(1);
    for (let i = 1; i <= 3; i += 1) {
      hub.onEvent(finished(`trn_${i}`));
      await settle(i + 1);
    }
    expect(continued).toEqual(['not done', 'not done', 'not done']);
    expect(outcomes.map((outcome) => outcome.action)).toEqual([
      'continued',
      'continued',
      'continued',
      'limit',
    ]);
    // 用户自己开的下一回合重新计数。
    hub.onEvent(finished('trn_user'));
    await settle(5);
    expect(continued).toHaveLength(4);
  });

  it('support：有接点的引擎有七种原生事件，没有的只有 Host 的四种加兜底的两种', () => {
    expect(dispatcher('codex').support()).toEqual([
      expect.objectContaining({ engine: 'codex', events: expect.arrayContaining(['PreToolUse']) }),
    ]);
    const fallback = dispatcher(undefined).support()[0];
    expect(fallback?.events).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PermissionRequest',
      'SessionEnd',
      'PostToolUse',
      'Stop',
    ]);
  });
});
