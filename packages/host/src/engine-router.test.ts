import type { AgentEvent, AgentRuntimeAdapter, ProviderConfig } from '@wevir/runtime-adapter';
import { EchoAccounts, EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { EngineRouter } from './engine-router.js';

const routers: EngineRouter[] = [];
afterEach(async () => {
  for (const router of routers.splice(0)) await router.dispose();
});

function provider(id: string, kind: ProviderConfig['kind']): ProviderConfig {
  return { id, kind, displayName: id, models: [{ id: 'm' }], defaultModelId: 'm' };
}

class Recording extends EchoAdapter {
  configured: ProviderConfig[] = [];
  async configureProviders(providers: readonly ProviderConfig[]): Promise<void> {
    this.configured = [...providers];
  }
}

/** 没有插话与分支的引擎：读这两个方法得到 undefined，其余照常。 */
function withoutSteer(inner: Recording): AgentRuntimeAdapter & { configured: ProviderConfig[] } {
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'steer' || property === 'fork') return undefined;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function collect(events: AsyncIterable<AgentEvent>, until: (event: AgentEvent) => boolean) {
  const seen: AgentEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (until(event)) break;
  }
  return seen;
}

function setup() {
  const api = new Recording({ stepDelayMs: 0 });
  const claudeEngine = new Recording({ stepDelayMs: 0 });
  const claude = withoutSteer(claudeEngine);
  const router = new EngineRouter([
    { name: 'echo', adapter: api, kinds: ['openai-compatible', 'chatgpt'] },
    { name: 'claude', adapter: claude, kinds: ['claude'] },
  ]);
  routers.push(router);
  return { api, claude, router };
}

describe('EngineRouter', () => {
  it('按 Provider 的种类分配引擎；每个引擎只拿到自己种类的 Provider', async () => {
    const { api, claude, router } = setup();
    await router.configureProviders([
      provider('local', 'openai-compatible'),
      provider('claude', 'claude'),
    ]);
    expect(api.configured.map((p) => p.id)).toEqual(['local']);
    expect(claude.configured.map((p) => p.id)).toEqual(['claude']);

    const session = await router.createSession({ cwd: '/w', providerId: 'claude', modelId: 'm' });
    const collecting = collect(
      router.subscribe(session.engineSessionId),
      (e) => e.type === 'turn.settled',
    );
    await router.send(session.engineSessionId, { content: [{ type: 'text', text: 'hi' }] });
    const events = await collecting;
    expect(events.some((event) => event.type === 'assistant.message')).toBe(true);
    // 会话只在 claude 那个 echo 里。
    await expect(
      api.send(session.engineSessionId, { content: [{ type: 'text', text: 'x' }] }),
    ).rejects.toMatchObject({
      code: 'session_not_found',
    });
  });

  it('子会话跟着派出它的引擎', async () => {
    const { claude, router } = setup();
    await router.configureProviders([provider('claude', 'claude')]);
    const session = await router.createSession({ cwd: '/w', providerId: 'claude', modelId: 'm' });
    await router.send(session.engineSessionId, { content: [{ type: 'text', text: 'subagent' }] });
    const events = await collect(
      router.subscribe(session.engineSessionId),
      (e) => e.type === 'subagent.started',
    );
    const started = events.find((event) => event.type === 'subagent.started');
    if (started?.type !== 'subagent.started') throw new Error('no subagent');
    await expect(router.listPendingApprovals(started.childEngineSessionId)).resolves.toEqual(
      await claude.listPendingApprovals(started.childEngineSessionId),
    );
    await router.cancel(started.childEngineSessionId);
  });

  it('有一个引擎支持的可选方法才出现；会话所在的引擎不支持时报 invalid_input', async () => {
    const { router } = setup();
    expect(router.steer).toBeDefined();
    await router.configureProviders([provider('claude', 'claude')]);
    const session = await router.createSession({ cwd: '/w', providerId: 'claude', modelId: 'm' });
    await expect(
      router.steer?.(session.engineSessionId, 's1', { content: [{ type: 'text', text: 'x' }] }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('没有引擎的种类：validateProvider 给出问题，建会话报 invalid_input；额外目录只给支持它的引擎', async () => {
    const { router } = setup();
    expect(router.validateProvider(provider('grok', 'grok'))).toEqual([
      { path: ['kind'], message: 'no engine for grok providers in this host' },
    ]);
    await router.configureProviders([provider('grok', 'grok'), provider('claude', 'claude')]);
    await expect(
      router.createSession({ cwd: '/w', providerId: 'grok', modelId: 'm' }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('账号按种类合并，状态变化一起转出', async () => {
    const accounts = new EchoAccounts({ delayMs: 1 });
    class WithAccounts extends EchoAdapter {
      readonly accounts = accounts;
    }
    const router = new EngineRouter([
      { name: 'echo', adapter: new EchoAdapter(), kinds: ['openai-compatible'] },
      { name: 'subs', adapter: new WithAccounts(), kinds: ['claude', 'cursor'] },
    ]);
    routers.push(router);
    expect(router.accounts?.kinds).toEqual(['claude', 'cursor', 'opencode', 'grok', 'antigravity']);
    const seen: string[] = [];
    router.accounts?.onChange((state) => seen.push(`${state.kind}:${state.status}`));
    await router.accounts?.logout('claude');
    expect(seen).toEqual(['claude:signed_out']);
    accounts.dispose();
  });
});
