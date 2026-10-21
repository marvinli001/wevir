// 档案的护栏层（0.86.0）：startHost 组装出的真实 Host（echo 引擎声明 Codex hooks 方言）。经 WebSocket 加护栏规则、启用仓库 hooks，
// 收到 `guardrail.changed` 与 `tuning.changed`，`tuning.get` 的护栏层里有它们。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class HookEcho extends EchoAdapter {
  hookDialect(): 'codex' {
    return 'codex';
  }
}

interface Item {
  id: string;
  label: string;
  scope: string;
  detail?: string;
}

describe('档案的护栏层经 Host API', () => {
  it('护栏规则与启用的仓库 hooks 进档案，改动发 tuning.changed', async () => {
    const root = realpathSync(tempDir());
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(join(project, '.codex'), { recursive: true });
    writeFileSync(
      join(project, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './x.sh' }] }],
        },
      }),
    );
    const host = await startHost({
      adapter: new HookEcho({ stepDelayMs: 1 }),
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
    const hello = await client.hello(token);
    expect(hello.result.features.tuning_guardrails).toBe(true);
    const workspaceId = (await client.request('workspace.add', { rootPath: project })).workspace
      .id as string;

    const guardrailItems = async (): Promise<Item[]> => {
      const current = await client.request('tuning.get', { workspaceId });
      const layer = (current.profile.layers as { key: string; items: Item[] }[]).find(
        (item) => item.key === 'guardrails',
      );
      return layer?.items ?? [];
    };
    expect(await guardrailItems()).toEqual([]);
    expect((await client.request('guardrail.list', { workspaceId })).guardrails).toEqual([]);
    const changes = () => client.notifications('tuning.changed').length;

    const rule = (
      await client.request('guardrail.add', {
        rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
      })
    ).guardrail;
    await client.until(() => (changes() >= 1 ? true : undefined), 'tuning.changed after add');
    await client.until(
      () => (client.notifications('guardrail.changed').length >= 1 ? true : undefined),
      'guardrail.changed after add',
    );
    expect(client.notifications('guardrail.changed')[0]).toEqual({});
    expect(await guardrailItems()).toEqual([
      expect.objectContaining({
        id: `guardrail:global:${rule.id}`,
        label: 'rm -rf',
        scope: 'global',
        detail: 'forbidden_command',
      }),
    ]);

    const before = changes();
    await client.request('repoHook.setEnabled', {
      workspaceId,
      hookId: '.codex/hooks.json:PreToolUse:0:0',
      enabled: true,
    });
    await client.until(() => (changes() > before ? true : undefined), 'tuning.changed after hook');
    expect(client.notifications('tuning.changed').at(-1)).toEqual({ workspaceId });
    expect((await guardrailItems()).map((item) => item.id)).toEqual([
      `guardrail:global:${rule.id}`,
      'repoHook:.codex/hooks.json:PreToolUse:0:0',
    ]);

    // 停用的规则不进档案。
    const beforeOff = changes();
    await client.request('guardrail.setEnabled', { guardrailId: rule.id, enabled: false });
    await client.until(() => (changes() > beforeOff ? true : undefined), 'tuning.changed off');
    expect((await guardrailItems()).map((item) => item.id)).toEqual([
      'repoHook:.codex/hooks.json:PreToolUse:0:0',
    ]);
  });
});
