import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { CodexRpcError } from './codex-process.js';
import { modelProviderFailure } from './model-provider-error.js';
import { managedPermissionFailure } from './permission-error.js';
import {
  collectEvents,
  collectingLogger,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, mockProvider } from './test-fixtures/mock-model.js';

const fake = fileURLToPath(new URL('./test-fixtures/fake-app-server.mjs', import.meta.url));
const dirs = new TempDirs();
const adapters: CodexAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
});

describe('Codex 托管权限拒绝（模拟 JSON-RPC）', () => {
  it.each([
    ['turn/start', 'sandbox_mode', 'DangerFullAccess', 'ReadOnly, WorkspaceWrite'],
    ['thread/resume', 'approval_policy', 'Never', 'OnRequest'],
    ['thread/start', 'approvals_reviewer', 'AutoReview', 'User'],
  ] as const)('%s 保留被拒的 %s 与允许值', async (method, field, requested, allowed) => {
    const paths = dirs.make('managed-permission-error');
    const adapter = newAdapter({
      home: paths.home,
      binary: process.execPath,
      binaryArgs: [fake],
      providers: [mockProvider({ baseURL: 'http://127.0.0.1:9/v1' })],
    });
    adapters.push(adapter);
    const config = { cwd: paths.workspace, providerId: 'mock', modelId: MOCK_MODEL };
    const session = method === 'turn/start' ? await adapter.createSession(config) : undefined;
    const original = adapter.process.request.bind(adapter.process);
    const rejection = new CodexRpcError(method, {
      code: -32600,
      message: `invalid thread settings override: invalid value for \`${field}\`: \`${requested}\` is not in the allowed set [${allowed}] (set by /etc/codex/requirements.toml)`,
    });
    vi.spyOn(adapter.process, 'request').mockImplementation(
      async <T>(name: string, params: unknown): Promise<T> => {
        if (name === method) throw rejection;
        return original<T>(name, params);
      },
    );
    const operation = session
      ? adapter.send(session.engineSessionId, { content: [{ type: 'text', text: 'test' }] })
      : method === 'thread/resume'
        ? adapter.resumeSession(randomUUID(), config)
        : adapter.createSession(config);
    await expect(operation).rejects.toMatchObject({
      code: 'invalid_input',
      message: `Codex 托管策略拒绝 ${field}=${requested}。允许值为 ${allowed}。切换权限模式，或联系管理员。`,
      cause: rejection,
    });
  });

  it('普通请求拒绝保持既有回退', () => {
    const rejection = new CodexRpcError('turn/start', {
      code: -32600,
      message: 'invalid thread settings override: invalid model requested',
    });
    expect(managedPermissionFailure(rejection)).toBeUndefined();
  });
});
afterAll(() => dirs.cleanup());

describe('结构化服务商错误（模拟 JSON-RPC）', () => {
  it.each([
    {
      method: 'turn/steer',
      data: {
        type: 'modelProviderMismatch',
        modelProvider: 'wevir_a',
        currentModelProvider: 'wevir_b',
      },
      code: 'engine_unavailable',
      message: '路由异常',
    },
    {
      method: 'turn/start',
      data: {
        type: 'modelProviderMismatch',
        modelProvider: 'wevir_a',
        currentModelProvider: 'wevir_b',
      },
      code: 'engine_unavailable',
      message: '路由异常',
    },
    {
      method: 'thread/resume',
      data: { type: 'modelProviderNotConfigured', modelProvider: 'wevir_deleted' },
      code: 'invalid_input',
      message: '服务商已删除',
    },
    {
      method: 'thread/start',
      data: {
        type: 'modelProviderPolicyConflict',
        modelProvider: 'wevir_a',
        requiredModelProvider: 'wevir_allowed',
      },
      code: 'invalid_input',
      message: '托管策略',
    },
  ])('$method：$data.type', async ({ method, data, code, message }) => {
    const paths = dirs.make('provider-error');
    const logger = collectingLogger();
    const adapter = newAdapter({
      home: paths.home,
      binary: process.execPath,
      binaryArgs: [fake],
      providers: [mockProvider({ baseURL: 'http://127.0.0.1:9/v1' })],
      logger,
    });
    adapters.push(adapter);
    const config = { cwd: paths.workspace, providerId: 'mock', modelId: MOCK_MODEL };
    const session = method.startsWith('turn/') ? await adapter.createSession(config) : undefined;
    const original = adapter.process.request.bind(adapter.process);
    vi.spyOn(adapter.process, 'request').mockImplementation(
      async <T>(name: string, params: unknown): Promise<T> => {
        if (name === method)
          throw new CodexRpcError(name, { code: -32600, message: 'native failure', data });
        return original<T>(name, params);
      },
    );
    if (method === 'turn/steer') {
      const events = collectEvents(adapter, session?.engineSessionId as string);
      await adapter.send(session?.engineSessionId as string, {
        content: [{ type: 'text', text: 'replay:approval-exec' }],
      });
      await waitForEvent(events, ofType('approval.requested'), '保持进行中的回合');
    }
    const action =
      method === 'turn/steer'
        ? adapter.steer(session?.engineSessionId as string, 'steer-1', {
            content: [{ type: 'text', text: 'steer' }],
          })
        : method === 'turn/start'
          ? adapter.send(session?.engineSessionId as string, {
              content: [{ type: 'text', text: 'test' }],
            })
          : method === 'thread/resume'
            ? adapter.resumeSession(randomUUID(), config)
            : adapter.createSession(config);
    await expect(action).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
    if (data.type === 'modelProviderMismatch') {
      expect(logger.warnings).toHaveLength(1);
      expect(logger.warnings[0]).toContain('wevir_a');
      expect(logger.warnings[0]).toContain('wevir_b');
    } else expect(logger.warnings).toEqual([]);
  });

  it('未知或不完整的 data 保留既有错误回退', () => {
    const logger = collectingLogger();
    for (const data of [
      undefined,
      { type: 'futureError' },
      { type: 'modelProviderMismatch', modelProvider: 'wevir_a' },
    ]) {
      expect(
        modelProviderFailure(
          new CodexRpcError('turn/start', { code: -32600, message: 'native', data }),
          logger,
        ),
      ).toBeUndefined();
    }
    expect(logger.warnings).toEqual([]);
  });
});
