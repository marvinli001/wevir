import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookOutcome, SessionId, TurnId, WevirEvent, WorkspaceId } from '@wevir/protocol';
import { type GuardrailMarker, guardrailChecker } from '@wevir/runtime-adapter/guardrail';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/** 异步跑 shell 命令（同一进程里的 HTTP 服务要能回应）。 */
function sh(line: string, input: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', line]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (status) => resolve({ status, stderr }));
    child.stdin.end(input);
  });
}

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
      handler: command('grep -q "rm -rf" && { echo "no rm -rf" >&2; exit 2; } || exit 0'),
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
    await hooks.add({ event: 'Stop', handler: command('echo "run the tests" >&2; exit 2') });
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
      handler: command('echo "blocked by policy" >&2; exit 2'),
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
      handler: command(
        'grep -q secret && { echo "no secrets" >&2; exit 2; } || echo "on branch main"',
      ),
    });
    await hooks.add({ event: 'SessionStart', handler: command('echo "read NOTES.md first"') });
    const hub = dispatcher(undefined);
    expect(await hub.userPromptSubmit(SES, 'print the secret')).toEqual({ blocked: 'no secrets' });
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
      handler: command(
        `echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'`,
      ),
    });
    expect(await hub.permissionRequest(SES, 'Bash', { command: 'ls' })).toEqual({
      behavior: 'allow',
    });
    expect(await hub.permissionRequest(SES, 'apply_patch', {})).toBeUndefined();
  });

  it('没有原生接点：回合结束后 Host 跑 Stop，要求继续时开后续回合，这串回合合计最多 3 次', async () => {
    await hooks.add({ event: 'Stop', handler: command('echo "not done" >&2; exit 2') });
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
    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    hub.onEvent(finished(TURN));
    await settle();
    for (let i = 1; i <= 3; i += 1) {
      hub.onEvent(finished(`trn_${i}`));
      await settle();
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
    await settle();
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
