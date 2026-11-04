import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayPrivacySource } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_ACCESS } from './config-tools.js';
import { EngineRouter } from './engine-router.js';
import { variablesRef } from './environment-variables.js';
import { type RunningHost, startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { HostSettingsStore } from './settings.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const temp = useTempDir();
const hosts: RunningHost[] = [];
const clients: TestRpcClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  for (const host of hosts.splice(0)) await host.shutdown();
  vi.unstubAllEnvs();
});

class PrivacyEcho extends EchoAdapter {
  source: GatewayPrivacySource | undefined;
  bindGatewayPrivacy(source: GatewayPrivacySource): void {
    this.source = source;
  }
}

describe('Host 网关隐私接线', () => {
  it('EngineRouter 传入动态设置、addSecret 值表、环境变量和连接器密钥，豁免原值不落盘', async () => {
    const home = join(temp(), 'home');
    const project = join(temp(), 'project');
    mkdirSync(project);
    const inner = new PrivacyEcho({ stepDelayMs: 0 });
    const adapter = new EngineRouter([
      { name: 'echo', kinds: ['openai-compatible'], adapter: inner },
    ]);
    const logger = createLogger();
    const host = await startHost({
      home,
      engine: 'echo',
      adapter,
      logger,
      userHome: join(temp(), 'user'),
      pluginUserHome: join(temp(), 'user'),
    });
    hosts.push(host);
    const client = await TestRpcClient.connect(host.url);
    clients.push(client);
    const runtime = JSON.parse(readFileSync(join(home, 'run/host.json'), 'utf8'));
    const hello = await client.hello(runtime.token);
    expect(hello.error).toBeUndefined();
    expect(hello.result).toMatchObject({ features: { gateway_privacy: true } });
    expect(inner.source?.settings()?.enabled).not.toBe(true);
    const first = 'fictional-log-value';
    const environmentValue = 'fictional-environment-value';
    const connectorValue = 'fictional-connector-value';
    vi.stubEnv('WEVIR_PRIVACY_TEST_VALUE', 'fictional-inherited-value');
    logger.addSecret(first);
    const { workspace } = await client.request('workspace.add', { rootPath: project });
    const { environment } = await client.request('environment.create', {
      name: 'test',
      folders: [{ workspaceId: workspace.id, worktree: 'none' }],
      variables: [{ name: 'TOKEN', value: environmentValue }],
    });
    await client.request('connector.add', {
      name: 'test',
      config: { transport: 'stdio', command: 'node', env: { TOKEN: connectorValue } },
    });
    const known = await inner.source?.secrets();
    for (const value of [first, environmentValue, connectorValue, 'fictional-inherited-value'])
      expect(known?.includes(value)).toBe(true);
    logger.addSecret('fictional-later-value');
    expect((await inner.source?.secrets())?.includes('fictional-later-value')).toBe(true);
    const valueHash = createHash('sha256').update(first).digest('hex');
    await client.request('settings.update', {
      settings: {
        gatewayPrivacy: {
          enabled: true,
          excludedValueHashes: [valueHash],
          excludedPatterns: ['^test_'],
        },
      },
    });
    expect(inner.source?.settings()).toEqual({
      enabled: true,
      excludedValueHashes: [valueHash],
      excludedPatterns: ['^test_'],
    });
    const persisted = readFileSync(join(home, 'settings.json'), 'utf8');
    for (const value of [first, environmentValue, connectorValue])
      expect(persisted).not.toContain(value);
    expect(persisted).toContain(valueHash);
    expect(SETTINGS_ACCESS.gatewayPrivacy).toBe('user');
    await new FileSecretStore(home).set(variablesRef(environment.id), 'invalid-json');
    await expect(inner.source?.secrets()).rejects.toThrow('privacy masking');
  });

  it('addSecret 快照不能修改日志的内部值表', () => {
    const logger = createLogger();
    logger.addSecret('fictional-value');
    const snapshot = logger.secretValues() as string[];
    snapshot.splice(0);
    expect(logger.secretValues()).toEqual(['fictional-value']);
  });

  it.each([
    '{',
    'null',
    '[]',
    JSON.stringify({ gatewayPrivacy: { enabled: true, excludedPatterns: ['['] } }),
  ])('损坏设置阻断隐私配置读取，只有明确保存隐私设置才解除', async (text) => {
    const path = join(temp(), 'settings.json');
    writeFileSync(path, text);
    const settings = new HostSettingsStore({ path, onWarning: () => {} });
    await settings.load();
    expect(() => settings.gatewayPrivacy()).toThrow('could not be loaded');
    await expect(settings.update({ sendWhileBusy: 'queue' })).rejects.toThrow(
      'save privacy settings first',
    );
    expect(() => settings.gatewayPrivacy()).toThrow('could not be loaded');
    await settings.update({ gatewayPrivacy: { enabled: true } });
    expect(settings.gatewayPrivacy()).toEqual({ enabled: true });
  });
});
