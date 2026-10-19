// 接力（0.25.0）在 SessionManager 上的细节：出错与只读的会话、没交出去的摘要、读历史工具的文件、权限模式、支线。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import type { HistoryFile } from '@wevir/runtime-adapter/history-tool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineRouter } from './engine-router.js';
import { EventStore } from './event-store.js';
import { MemoryStore } from './memory.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-15T00:00:00.000Z';

describe('接力（SessionManager）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(options: { claudeModes?: boolean; autoMemory?: () => boolean } = {}) {
    const root = join(realpathSync(tempDir()), `h${managers.length}`);
    mkdirSync(root);
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock API',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'claude',
      kind: 'claude',
      displayName: 'Claude Agent',
      models: [{ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }],
      defaultModelId: 'claude-opus-5-5',
      createdAt: T0,
      updatedAt: T0,
    });
    const api = new EchoAdapter({ stepDelayMs: 0 });
    const claude = new EchoAdapter({ stepDelayMs: 0 });
    const router = new EngineRouter([
      { name: 'echo', adapter: api, kinds: ['openai-compatible'] },
      { name: 'echo-claude', adapter: claude, kinds: ['claude'] },
    ]);
    void router.configureProviders([
      { id: 'mock', kind: 'openai-compatible' } as never,
      { id: 'claude', kind: 'claude' } as never,
    ]);
    const features = router.engineFeatures();
    // 假装 Claude 的引擎挂了读历史的工具；`claudeModes: false` 时它不认权限模式。
    const { permissionModes, ...claudeFeatures } = features.claude ?? { engine: 'echo-claude' };
    const engineFeatures = {
      ...features,
      claude: {
        ...claudeFeatures,
        historyTool: true,
        ...(options.claudeModes !== false && permissionModes !== undefined && { permissionModes }),
      },
    };
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const historyDir = join(root, 'data', 'history');
    const memory = new MemoryStore({ dir: join(root, 'data', 'memory') });
    const manager = new SessionManager({
      storage,
      events,
      adapter: router,
      engine: 'echo',
      engineFeatures,
      historyDir,
      memory,
      ...(options.autoMemory !== undefined && { memoryEnabled: options.autoMemory }),
    });
    managers.push(manager);
    return { storage, events, manager, api, claude, historyDir, memory };
  }

  async function turn(env: ReturnType<typeof setup>, sessionId: SessionId, text: string) {
    await env.manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'), {
      timeout: 5000,
    });
  }

  function handoffs(env: ReturnType<typeof setup>, sessionId: SessionId) {
    return env.events
      .readSince(sessionId, 0)
      .filter(
        (event): event is Extract<WevirEvent, { type: 'session.handoff' }> =>
          event.type === 'session.handoff',
      );
  }

  function lastAnswer(env: ReturnType<typeof setup>, sessionId: SessionId): string {
    const answer = env.events
      .readSince(sessionId, 0)
      .findLast((event) => event.type === 'assistant.message');
    return answer?.type === 'assistant.message' ? answer.payload.text : '';
  }

  it('写读历史工具的文件，摘要里提这个工具；文件里是全文', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    const long = `很长的说明 ${'x'.repeat(600)}`;
    await turn(env, sessionId, long);
    await env.manager.configure({ sessionId, providerId: 'claude' });
    const [handoff] = handoffs(env, sessionId);
    expect(handoff?.payload.context).toContain('read_session_history');
    const file = JSON.parse(
      readFileSync(join(env.historyDir, `${sessionId}.json`), 'utf8'),
    ) as HistoryFile;
    expect(file).toMatchObject({ sessionId, throughSeq: (handoff?.seq ?? 0) - 1 });
    expect(file.items[0]).toMatchObject({ position: 1, kind: 'user_message', text: long });
    // 摘要里只是截短的。
    expect(handoff?.payload.context).not.toContain(long);
  });

  it('引擎退出、回合以 interrupted 结束时摘要没交出去，下一条消息接着带', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, '第一句');
    await env.manager.configure({ sessionId, providerId: 'claude' });
    await env.manager.send(
      { sessionId, content: [{ type: 'text', text: 'slow 慢慢说' }] },
      identity,
    );
    await env.claude.simulateEngineExit();
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('error'));
    expect(env.events.handoffState(sessionId)?.context).toContain('Context handoff');

    await env.manager.resume(sessionId);
    await turn(env, sessionId, '再来一次');
    expect(lastAnswer(env, sessionId)).toContain('Context handoff (full_thread_summary)');
    expect(env.events.handoffState(sessionId)?.context).toBeUndefined();
    await turn(env, sessionId, '第三句');
    expect(lastAnswer(env, sessionId)).not.toContain('Context handoff');
  });

  it('接力后先压缩：压缩的回合不带摘要，摘要留给下一条消息', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, '第一句');
    await env.manager.configure({ sessionId, providerId: 'claude' });
    const { turnId } = await env.manager.compact(sessionId);
    await vi.waitFor(() =>
      expect(
        env.events
          .readSince(sessionId, 0)
          .some((event) => event.type === 'turn.finished' && event.payload.turnId === turnId),
      ).toBe(true),
    );
    expect(env.events.handoffState(sessionId)).toMatchObject({
      currentSeen: 0,
      context: expect.stringContaining('Context handoff'),
    });
    await turn(env, sessionId, '接着来');
    expect(lastAnswer(env, sessionId)).toContain('Context handoff (full_thread_summary)');
    expect(env.events.handoffState(sessionId)?.context).toBeUndefined();
  });

  it('出错的会话可以接力：转回 idle；原来的引擎会话关掉', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'hello');
    await env.api.simulateEngineExit();
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('error'));
    const session = await env.manager.configure({ sessionId, providerId: 'claude' });
    expect(session).toMatchObject({ state: 'idle', providerId: 'claude' });
    const types = env.events.readSince(sessionId, 0).map((event) => event.type);
    expect(types.slice(-2)).toEqual(['session.handoff', 'session.state_changed']);
    await turn(env, sessionId, '接着来');
    expect(lastAnswer(env, sessionId)).toContain('User message:\n接着来');
  });

  it('新引擎建不起来时不写事件，会话还是原来的 Provider，下次发消息恢复原来的引擎会话', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'hello');
    await env.claude.dispose();
    await expect(env.manager.configure({ sessionId, providerId: 'claude' })).rejects.toMatchObject({
      code: 'ENGINE_ERROR',
    });
    expect(handoffs(env, sessionId)).toHaveLength(0);
    expect(env.events.snapshot(sessionId)?.session.providerId).toBe('mock');
    await turn(env, sessionId, '还在');
    expect(lastAnswer(env, sessionId)).toBe('Echo: 还在');
  });

  it('沿用的权限模式新引擎不支持时退回 on_request；明说的不支持时拒绝', async () => {
    const env = setup();
    const { id } = await env.manager.create({
      workspaceId: 'ws_1',
      providerId: 'mock',
      permissionMode: 'full_access',
    });
    const sessionId = id as SessionId;
    const kept = await env.manager.configure({ sessionId, providerId: 'claude' });
    expect(kept.permissionMode).toBe('full_access');

    const narrow = setup({ claudeModes: false });
    const other = await narrow.manager.create({
      workspaceId: 'ws_1',
      providerId: 'mock',
      permissionMode: 'auto_review',
    });
    await expect(
      narrow.manager.configure({
        sessionId: other.id as SessionId,
        providerId: 'claude',
        permissionMode: 'full_access',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const fallback = await narrow.manager.configure({
      sessionId: other.id as SessionId,
      providerId: 'claude',
    });
    expect(fallback.permissionMode).toBeUndefined();
  });

  it('刚接力、新引擎还没跑过回合时不能分支线；跑过一个回合就可以', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'hello');
    await env.manager.configure({ sessionId, providerId: 'claude' });
    await expect(env.manager.fork({ sessionId, side: true })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await turn(env, sessionId, '在 Claude 上说一句');
    const side = await env.manager.fork({ sessionId, side: true });
    expect(side).toMatchObject({ providerId: 'claude', side: true });
  });

  it('支线会话不能接力', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'hello');
    const side = await env.manager.fork({ sessionId, side: true });
    await expect(
      env.manager.configure({ sessionId: side.id as SessionId, providerId: 'claude' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  describe('必须携带的约束与选入的笔记（0.59.0）', () => {
    const LONG = `约定：金额一律用整数分；测试只用 npm test，不改 test/ 目录；不加新依赖。${'后面还有一些补充说明，'.repeat(30)}最后一条：新函数用 snake_case 命名，并在上方写一行 // @spec 注释。`;

    async function seeded(options: Parameters<typeof setup>[0] = {}) {
      const env = setup(options);
      await env.memory.save('project', 'ws_1', {
        name: 'invoice-cents',
        type: 'feedback',
        description: 'Discounts are computed in integer cents',
        content: 'Compute discounts in integer cents and round once.',
      });
      await env.memory.save('global', undefined, {
        name: 'reply-language',
        type: 'user',
        description: 'Reply in Chinese',
        content: 'The user prefers answers in Chinese.',
      });
      const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
      const sessionId = id as SessionId;
      await turn(env, sessionId, LONG);
      return { ...env, sessionId };
    }

    it('约束整条、笔记整条随下一条消息交给新引擎；事件里有递交记录', async () => {
      const env = await seeded();
      const note = await env.memory.read('project', 'ws_1', 'invoice-cents');
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: {
          constraints: [LONG],
          notes: [
            { scope: 'project', name: 'invoice-cents' },
            { scope: 'global', name: 'reply-language' },
          ],
        },
      });
      const [handoff] = handoffs(env, env.sessionId);
      const payload = handoff?.payload;
      const context = payload?.context ?? '';
      expect(context).toContain(`[user; must_carry; constraint=1]\n${LONG}`);
      expect(context).toContain('Compute discounts in integer cents and round once.');
      expect(payload).toMatchObject({
        constraints: 1,
        notes: [
          { scope: 'project', name: 'invoice-cents', revision: note.revision },
          { scope: 'global', name: 'reply-language' },
        ],
        bytes: Buffer.byteLength(context),
        budgetBytes: 16_000,
        historyTool: true,
        items: 2,
        omittedItems: 0,
      });
      expect(payload?.hash).toMatch(/^[0-9a-f]{64}$/);
      await turn(env, env.sessionId, '接着做');
      // echo 把收到的整条输入原样说回来：交给引擎的就是事件里的材料，一字不差。
      expect(lastAnswer(env, env.sessionId)).toBe(`Echo: ${context}\n\nUser message:\n接着做`);
    });

    it('停用的、找不到的、选了两次的笔记与自动记忆关着时都拒绝，在动原来的引擎会话之前', async () => {
      let autoMemory = true;
      const env = await seeded({ autoMemory: () => autoMemory });
      await env.memory.setEnabled('project', 'ws_1', 'invoice-cents', false);
      const attempt = (notes: { scope: 'project' | 'global'; name: string }[]) =>
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { notes },
        });
      await expect(attempt([{ scope: 'project', name: 'invoice-cents' }])).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringContaining('turned off'),
      });
      await expect(attempt([{ scope: 'project', name: 'nope' }])).rejects.toMatchObject({
        code: 'MEMORY_NOT_FOUND',
      });
      await expect(
        attempt([
          { scope: 'global', name: 'reply-language' },
          { scope: 'global', name: 'reply-language' },
        ]),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      autoMemory = false;
      await expect(attempt([{ scope: 'global', name: 'reply-language' }])).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringContaining('automatic memory is off'),
      });
      // 约束不受自动记忆影响。
      expect(handoffs(env, env.sessionId)).toHaveLength(0);
      expect(env.events.snapshot(env.sessionId)?.session.providerId).toBe('mock');
      await turn(env, env.sessionId, '还在');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 还在');
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { constraints: ['只改 src/'] },
      });
      expect(handoffs(env, env.sessionId)[0]?.payload.constraints).toBe(1);
    });

    it('别的项目的笔记选不到：project 指会话所在的项目', async () => {
      const env = await seeded();
      await env.memory.save('project', 'ws_2', {
        name: 'other-secret',
        type: 'project',
        description: 'Other project',
        content: 'Should not leak.',
      });
      await expect(
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { notes: [{ scope: 'project', name: 'other-secret' }] },
        }),
      ).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    });

    it('约束加开头说明超出预算时报超限，不截短、不写事件，会话还是原来的来源', async () => {
      const env = await seeded();
      await expect(
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { constraints: ['约'.repeat(2000), '定'.repeat(2000), '束'.repeat(2000)] },
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
        message: expect.stringMatching(/over the budget of 16000 bytes/),
      });
      expect(handoffs(env, env.sessionId)).toHaveLength(0);
      expect(env.events.snapshot(env.sessionId)?.session.providerId).toBe('mock');
      await turn(env, env.sessionId, '还在');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 还在');
    });

    it('同一条消息重发（clientMessageId 相同）不重复附加；之后的消息不再带', async () => {
      const env = await seeded();
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { constraints: ['只改 src/'] },
      });
      const message = {
        sessionId: env.sessionId,
        content: [{ type: 'text' as const, text: '接着做' }],
        clientMessageId: 'msg-retry',
      };
      const first = await env.manager.send(message, identity);
      const again = await env.manager.send(message, identity);
      expect(again).toEqual(first);
      await vi.waitFor(() =>
        expect(env.events.snapshot(env.sessionId)?.session.state).toBe('idle'),
      );
      const answers = env.events
        .readSince(env.sessionId, 0)
        .flatMap((event) => (event.type === 'assistant.message' ? [event.payload.text] : []));
      expect(
        answers.filter((text) => text.includes('[user; must_carry; constraint=1]')),
      ).toHaveLength(1);
      await turn(env, env.sessionId, '第三句');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 第三句');
    });

    it('换回旧来源仍是增量；恢复不了时改交整段（不带绑定时的原有行为）', async () => {
      const env = await seeded();
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'claude' });
      await turn(env, env.sessionId, '在 Claude 上');
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'mock' });
      expect(handoffs(env, env.sessionId).at(-1)?.payload).toMatchObject({
        resumed: true,
        strategy: 'delta_since_target_last_seen',
      });
      await turn(env, env.sessionId, '回到 API');
      // Claude 那边以前的引擎会话没了：恢复失败，新建、交整段。
      const resume = vi
        .spyOn(env.claude, 'resumeSession')
        .mockRejectedValue(new Error('session_lost'));
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'claude' });
      expect(handoffs(env, env.sessionId).at(-1)?.payload).toMatchObject({
        resumed: false,
        strategy: 'full_thread_summary',
        covered: { fromSeq: 1 },
      });
      expect(resume).toHaveBeenCalledTimes(1);
      resume.mockRestore();
    });
  });

  describe('预览与绑定（0.60.0）', () => {
    async function started() {
      const env = setup();
      await env.memory.save('project', 'ws_1', {
        name: 'invoice-cents',
        type: 'feedback',
        description: 'Discounts are computed in integer cents',
        content: 'Compute discounts in integer cents and round once.',
      });
      const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
      const sessionId = id as SessionId;
      await turn(env, sessionId, '第一句');
      return { ...env, sessionId };
    }
    const handoff = {
      constraints: ['只改 src/，金额用整数分'],
      notes: [{ scope: 'project' as const, name: 'invoice-cents' }],
    };

    it('预览只读；带着它的绑定切换，递交的材料与预览逐字节一致', async () => {
      const env = await started();
      const before = env.events.readSince(env.sessionId, 0).length;
      const { preview, binding } = await env.manager.handoffPreview({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff,
      });
      expect(env.events.readSince(env.sessionId, 0)).toHaveLength(before);
      expect(env.events.snapshot(env.sessionId)?.session.providerId).toBe('mock');
      expect(preview).toMatchObject({
        providerId: 'claude',
        strategy: 'full_thread_summary',
        resumed: false,
        historyTool: true,
        constraints: 1,
        items: 2,
        omittedItems: 0,
      });
      expect(binding).toMatchObject({
        providerId: 'claude',
        throughSeq: env.events.snapshot(env.sessionId)?.session.lastSeq,
        hash: preview.hash,
      });
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { ...handoff, ...(binding && { binding }) },
      });
      const payload = handoffs(env, env.sessionId)[0]?.payload;
      expect(payload?.context).toBe(preview.context);
      expect(payload).toMatchObject({
        hash: preview.hash,
        bytes: preview.bytes,
        notes: preview.notes,
      });
      await turn(env, env.sessionId, '接着做');
      expect(lastAnswer(env, env.sessionId)).toBe(
        `Echo: ${preview.context}\n\nUser message:\n接着做`,
      );

      // 再点一次确认（同样的请求）：已经在 Claude 上，什么都不做，不重复附加。
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { ...handoff, ...(binding && { binding }) },
      });
      expect(handoffs(env, env.sessionId)).toHaveLength(1);
      await turn(env, env.sessionId, '第三句');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 第三句');
    });

    it('预览之后有新事件、笔记被改、约束不同或目标不同：旧预览不能原样通过，什么都不动', async () => {
      const env = await started();
      const take = () =>
        env.manager.handoffPreview({ sessionId: env.sessionId, providerId: 'claude', handoff });
      const commit = (binding: unknown, extra: object = {}) =>
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { ...handoff, ...extra, binding: binding as never },
        });

      const stale = (await take()).binding;
      await turn(env, env.sessionId, '又说了一句');
      await expect(commit(stale)).rejects.toMatchObject({
        code: 'HANDOFF_STALE',
        data: { reasons: ['events'] },
      });

      const beforeNote = (await take()).binding;
      // 用户在设置里改了正文。
      const current = await env.memory.read('project', 'ws_1', 'invoice-cents');
      await env.memory.update('project', 'ws_1', 'invoice-cents', current.revision, {
        content: 'Round discounts once, at the end.',
      });
      await expect(commit(beforeNote)).rejects.toMatchObject({
        code: 'HANDOFF_STALE',
        data: { reasons: ['notes'] },
      });

      const fresh = (await take()).binding;
      await expect(commit(fresh, { constraints: ['只改 src/'] })).rejects.toMatchObject({
        code: 'HANDOFF_STALE',
        data: { reasons: ['material'] },
      });
      await expect(
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { ...handoff, binding: { ...(fresh as object), providerId: 'mock' } as never },
        }),
      ).rejects.toMatchObject({ code: 'HANDOFF_STALE', data: { reasons: ['target'] } });

      // 笔记停用了：拒绝（不能选停用的）。
      await env.memory.setEnabled('project', 'ws_1', 'invoice-cents', false);
      await expect(commit(fresh)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await env.memory.setEnabled('project', 'ws_1', 'invoice-cents', true);

      // 上面都没动原来的引擎会话：照常回答。
      expect(handoffs(env, env.sessionId)).toHaveLength(0);
      await turn(env, env.sessionId, '还在');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 还在');

      // 刷新预览后照常切换。
      const last = (await take()).binding;
      await commit(last);
      expect(handoffs(env, env.sessionId)).toHaveLength(1);
    });

    it('预览按恢复以前的引擎会话算出增量，切换时恢复失败：回 HANDOFF_STALE、不新建不切换；再预览是新建整段，确认后切换', async () => {
      const env = await started();
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'claude' });
      await turn(env, env.sessionId, '在 Claude 上');
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'mock' });
      await turn(env, env.sessionId, '回到 API');

      const first = await env.manager.handoffPreview({
        sessionId: env.sessionId,
        providerId: 'claude',
      });
      expect(first.preview).toMatchObject({
        strategy: 'delta_since_target_last_seen',
        resumed: true,
      });
      const resume = vi
        .spyOn(env.claude, 'resumeSession')
        .mockRejectedValue(new Error('session_lost'));
      const create = vi.spyOn(env.claude, 'createSession');
      await expect(
        env.manager.configure({
          sessionId: env.sessionId,
          providerId: 'claude',
          handoff: { ...(first.binding && { binding: first.binding }) },
        }),
      ).rejects.toMatchObject({ code: 'HANDOFF_STALE', data: { reasons: ['resume_failed'] } });
      expect(create).not.toHaveBeenCalled();
      expect(handoffs(env, env.sessionId)).toHaveLength(2);
      expect(env.events.snapshot(env.sessionId)?.session.providerId).toBe('mock');
      // 原来的引擎会话下次发消息时恢复。
      await turn(env, env.sessionId, '还在 API');
      expect(lastAnswer(env, env.sessionId)).toBe('Echo: 还在 API');

      const second = await env.manager.handoffPreview({
        sessionId: env.sessionId,
        providerId: 'claude',
      });
      expect(second.preview).toMatchObject({ strategy: 'full_thread_summary', resumed: false });
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { ...(second.binding && { binding: second.binding }) },
      });
      expect(resume).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
      const payload = handoffs(env, env.sessionId).at(-1)?.payload;
      expect(payload).toMatchObject({ resumed: false, strategy: 'full_thread_summary' });
      expect(payload?.context).toBe(second.preview.context);
      resume.mockRestore();
      create.mockRestore();
    });

    it('换回旧来源的预览仍是增量，带绑定切换照样是增量', async () => {
      const env = await started();
      await env.manager.configure({ sessionId: env.sessionId, providerId: 'claude' });
      await turn(env, env.sessionId, '在 Claude 上');
      const { preview, binding } = await env.manager.handoffPreview({
        sessionId: env.sessionId,
        providerId: 'mock',
      });
      expect(preview).toMatchObject({ strategy: 'delta_since_target_last_seen', resumed: true });
      await env.manager.configure({
        sessionId: env.sessionId,
        providerId: 'mock',
        handoff: { ...(binding && { binding }) },
      });
      expect(handoffs(env, env.sessionId).at(-1)?.payload).toMatchObject({
        resumed: true,
        strategy: 'delta_since_target_last_seen',
        context: preview.context,
      });
    });

    it('超出预算的预览没有材料与绑定；预览与切换的限制相同', async () => {
      const env = await started();
      const over = await env.manager.handoffPreview({
        sessionId: env.sessionId,
        providerId: 'claude',
        handoff: { constraints: ['约'.repeat(2000), '定'.repeat(2000), '束'.repeat(2000)] },
      });
      expect(over.binding).toBeUndefined();
      expect(over.preview.context).toBeUndefined();
      expect(over.preview.overBudget?.bytes).toBeGreaterThan(over.preview.budgetBytes);

      await expect(
        env.manager.handoffPreview({ sessionId: env.sessionId, providerId: 'mock' }),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(
        env.manager.handoffPreview({ sessionId: env.sessionId, providerId: 'gone' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
      const side = await env.manager.fork({ sessionId: env.sessionId, side: true });
      await expect(
        env.manager.handoffPreview({ sessionId: side.id as SessionId, providerId: 'claude' }),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      await env.manager.send(
        { sessionId: env.sessionId, content: [{ type: 'text', text: 'slow 慢慢说' }] },
        identity,
      );
      await expect(
        env.manager.handoffPreview({ sessionId: env.sessionId, providerId: 'claude' }),
      ).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    });
  });
});
