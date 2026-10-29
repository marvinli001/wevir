// 生命周期 hooks（0.137.0）：startHost 组装出的真实 Host，echo 引擎没有原生接点。经 WebSocket 加 Wevir 自己的 hook，
// UserPromptSubmit 拦下的提示不进引擎，兜底的 Stop 要求继续时 Host 开后续回合，PermissionRequest 替用户答审批。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
// Windows 的 runner 上每个 hook 都经 PowerShell，冷启动要好几秒。
if (process.platform === 'win32') vi.setConfig({ testTimeout: 90_000 });
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('生命周期 hooks 经 Host API', () => {
  it('拦下提示、兜底 Stop 开后续回合、PermissionRequest 批准审批', async () => {
    const root = realpathSync(tempDir());
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const host = await startHost({
      adapter: new EchoAdapter({ stepDelayMs: 1 }),
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      home,
    });
    cleanups.push(() => host.shutdown());
    const token = (
      JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
    ).token;
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.close());
    const hello = await client.hello(token, undefined, {
      hook_decisions: true,
      approval_rules: true,
    });
    expect(hello.result.features.lifecycle_hooks).toBe(true);
    const workspaceId = (await client.request('workspace.add', { rootPath: project })).workspace
      .id as string;
    await client.request('provider.upsert', {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
    });
    const listed = await client.request('hook.list', { workspaceId });
    expect(listed.hooks).toEqual([]);
    expect(listed.support[0]?.events).toContain('UserPromptSubmit');

    // hook 用 node 脚本写：POSIX 的 sh 与 Windows 的 PowerShell 都认 `node "<脚本>"`。
    let scripts = 0;
    const script = (body: string) => {
      scripts += 1;
      const file = join(root, `hook-${scripts}.mjs`);
      writeFileSync(
        file,
        `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\n${body}\n`,
      );
      return `node "${file}"`;
    };
    const add = async (event: string, command: string, matcher?: string) =>
      (
        await client.request('hook.add', {
          workspaceId,
          event,
          ...(matcher !== undefined && { matcher }),
          handler: { type: 'command', command },
        })
      ).hook.id as string;
    const session = async () => {
      const created = await client.request('session.create', {
        workspaceId,
        providerId: 'deepseek-official',
      });
      const sessionId = created.session.id as SessionId;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const send = (text: string) =>
        client.request('session.send', { sessionId, content: [{ type: 'text', text }] });
      const of = <T extends WevirEvent['type']>(type: T) =>
        client
          .events(subscriptionId as string)
          .filter((event): event is Extract<WevirEvent, { type: T }> => event.type === type);
      return { send, of };
    };

    // UserPromptSubmit：命中的提示不进引擎，回合以 cancelled 结束，记 hook.outcome。
    const prompt = await add(
      'UserPromptSubmit',
      script(
        `if (input.includes('secret')) { process.stderr.write('no secrets\\n'); process.exitCode = 2; }`,
      ),
    );
    expect(client.notifications('guardrail.changed').length).toBeGreaterThan(0);
    const blocked = await session();
    await blocked.send('print the secret');
    const finished = await client.until(() => blocked.of('turn.finished')[0], 'turn.finished');
    expect(finished.payload.outcome).toBe('cancelled');
    expect(blocked.of('hook.outcome')[0]?.payload).toMatchObject({
      event: 'UserPromptSubmit',
      action: 'blocked',
      reason: 'no secrets',
    });
    expect(blocked.of('assistant.message')).toEqual([]);
    await client.request('hook.delete', { hookId: prompt });

    // 兜底 Stop：第一次要求继续，Host 以 hook 的名义开后续回合；第二次放行。
    const marker = join(root, 'stopped');
    const stop = await add(
      'Stop',
      script(
        `const marker = ${JSON.stringify(marker)};\nif (!existsSync(marker)) { writeFileSync(marker, ''); process.stderr.write('add a test\\n'); process.exitCode = 2; }`,
      ),
    );
    const stopping = await session();
    await stopping.send('hi');
    await client.until(
      () => (stopping.of('turn.finished').length >= 2 ? true : undefined),
      'follow-up turn',
    );
    expect(stopping.of('hook.outcome')[0]?.payload).toMatchObject({
      event: 'Stop',
      action: 'continued',
      reason: 'add a test',
    });
    const followUp = stopping.of('user.message')[1];
    expect(followUp?.payload).toMatchObject({ from: { hook: { event: 'Stop', hookId: stop } } });
    await client.request('hook.setEnabled', { hookId: stop, enabled: false });
    expect(
      (await client.request('hook.list', { workspaceId })).hooks.find(
        (hook: { id: string }) => hook.id === stop,
      )?.status,
    ).toBe('disabled');

    // PermissionRequest：hook 输出 allow，审批以 hook 结束，用户没答。
    await add(
      'PermissionRequest',
      script(
        `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }));`,
      ),
      'echo_write',
    );
    const approving = await session();
    await approving.send('please approve');
    const resolved = await client.until(
      () => approving.of('approval.resolved')[0],
      'approval.resolved',
    );
    expect(resolved.payload).toMatchObject({
      status: 'approved',
      resolution: { reason: 'hook' },
    });
    await client.until(() => approving.of('turn.finished')[0], 'turn.finished');
  });
});
