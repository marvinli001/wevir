import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntigravityAdapter } from '@wevir/adapter-antigravity';
import { ErrorCode } from '@wevir/protocol';
import { expect, it, vi } from 'vitest';
import {
  installFakeRuntime,
  writeFakeToken,
} from '../../adapter-antigravity/src/test-fixtures/runtime.js';
import { EngineRouter } from './engine-router.js';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { identity, TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();

it.skipIf(process.platform === 'win32')(
  '原生 Antigravity 写文件前等待 Host 的批准，拒绝后不写，只接受本次批准',
  async () => {
    const root = tempDir();
    const home = join(root, 'home');
    const workspaceDir = join(root, 'workspace');
    const output = join(root, 'outside.txt');
    const prompt = join(root, 'prompt.txt');
    const rule = 'Use the project date format.';
    mkdirSync(workspaceDir);
    mkdirSync(join(root, '.gemini'));
    writeFileSync(join(root, '.gemini', 'GEMINI.md'), rule);
    writeFakeToken(home);
    const executable = installFakeRuntime(join(root, 'bin'), { native: true });
    const runtime = new AntigravityAdapter({
      home,
      env: {
        HOME: root,
        PATH: '',
        FAKE_AGY_APPROVAL_OUTPUT: output,
        FAKE_AGY_PROMPT_DUMP: prompt,
      },
    });
    const host = await startHost({
      home,
      userHome: root,
      adapter: new EngineRouter([
        { name: 'antigravity', kinds: ['antigravity'], adapter: runtime },
      ]),
      engine: 'antigravity',
      logger: createLogger({ mirror: () => {} }),
    });
    let connection: TestRpcClient | undefined;
    try {
      const client = await TestRpcClient.connect(host.url);
      connection = client;
      const { token } = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      expect(
        (await client.hello(token as string, identity, { subscription_kinds: true })).error,
      ).toBeUndefined();
      await client.request('account.setPath', { kind: 'antigravity', path: executable });
      await client.request('account.get', { kind: 'antigravity', refresh: true });
      await vi.waitFor(async () => {
        const { providers } = await client.request('provider.list');
        expect(providers).toContainEqual(expect.objectContaining({ id: 'antigravity' }));
      });
      const { workspace } = await client.request('workspace.add', { rootPath: workspaceDir });
      const { session } = await client.request('session.create', {
        workspaceId: workspace.id,
        providerId: 'antigravity',
        permissionMode: 'on_request',
      });
      const sessionId = session.id;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const events = () => client.events(subscriptionId);

      for (const { optionId, status } of [
        { optionId: 'deny', status: 'denied' },
        { optionId: 'once', status: 'approved' },
      ]) {
        const { turnId } = await client.request('session.send', {
          sessionId,
          content: [{ type: 'text', text: 'approve' }],
        });
        const requested = await client.until(
          () =>
            events().find(
              (event) =>
                event.type === 'approval.requested' && event.payload.approval.turnId === turnId,
            ),
          'Antigravity approval request',
        );
        if (requested.type !== 'approval.requested') throw new Error('unexpected event');
        expect(requested.source).toBe('engine');
        const { id: approvalId, options } = requested.payload.approval;
        expect(options.map((option) => option.kind)).toEqual(['allow_once', 'reject_once']);
        expect((await client.request('session.get', { sessionId })).session.state).toBe(
          'awaiting_approval',
        );
        expect(existsSync(output)).toBe(false);
        if (status === 'denied') expect(readFileSync(prompt, 'utf8')).toContain(rule);
        const unsupported = await client.call('approval.respond', {
          approvalId,
          optionId: 'remember',
        });
        expect(unsupported.error?.code).toBe(ErrorCode.INVALID_PARAMS);
        expect(existsSync(output)).toBe(false);

        await client.request('approval.respond', { approvalId, optionId });
        await client.until(
          () =>
            events().find(
              (event) => event.type === 'turn.finished' && event.payload.turnId === turnId,
            ),
          'Antigravity turn finished',
        );
        expect(events()).toContainEqual(
          expect.objectContaining({
            type: 'approval.resolved',
            payload: expect.objectContaining({
              approvalId,
              status,
              resolution: expect.objectContaining({ reason: 'user', optionId }),
            }),
          }),
        );
        if (status === 'denied') expect(existsSync(output)).toBe(false);
      }
      expect(readFileSync(output, 'utf8')).toBe('hello');
    } finally {
      connection?.ws.terminate();
      await host.shutdown();
    }
  },
);
