// 写作风格的存储（store.ts）、聊天记录的收集（chat-samples.ts）与应用级工具（tools.ts）。

import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import type { AppTool, AppToolCall } from '../app-mcp.js';
import { seedSession, T0, useStorages, useTempDir } from '../test-utils.js';
import { collectChatSamples, ownText } from './chat-samples.js';
import { SAMPLE_MAX_CHARS, SAMPLES_MAX_AGE_MS, sampleSlug, WritingStyleStore } from './store.js';
import { WRITING_STYLE_OFF_MESSAGE, WRITING_STYLE_TOOLS, writingStyleTools } from './tools.js';

const tempDir = useTempDir();
const storages = useStorages();

function storeAt(now = () => new Date('2026-10-21T00:00:00.000Z')) {
  return new WritingStyleStore({ dir: join(tempDir(), 'writing-style'), now });
}

describe('WritingStyleStore', () => {
  it('保存、读回、整份替换；revision 跟着变，0600 文件', async () => {
    const store = storeAt();
    expect(await store.get()).toBeUndefined();
    const first = await store.save('  # 写法\n\n- 句子短。\n', { by: 'agent' });
    expect(first.profile).toMatchObject({
      content: '# 写法\n\n- 句子短。',
      updatedBy: 'agent',
      setupComplete: false,
    });
    expect(await store.get()).toEqual(first.profile);
    const second = await store.save('# 写法\n\n- 先说结论。', { by: 'agent' });
    expect(second.profile.revision).not.toBe(first.profile.revision);
    expect((await store.get())?.content).toBe('# 写法\n\n- 先说结论。');
    if (process.platform !== 'win32') {
      expect(statSync(join(tempDir(), 'writing-style', 'profile.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('带旧 revision 的用户改动不写，回现在的档案与 conflict', async () => {
    const store = storeAt();
    const { profile } = await store.save('A', { by: 'agent' });
    await store.save('B', { by: 'agent' });
    const result = await store.save('C', { by: 'user', revision: profile.revision });
    expect(result.conflict).toBe(true);
    expect(result.profile.content).toBe('B');
  });

  it('空的与太长的拒绝', async () => {
    const store = storeAt();
    await expect(store.save(' \n', { by: 'agent' })).rejects.toThrow(/empty/);
    await expect(store.save('x'.repeat(16_001), { by: 'agent' })).rejects.toThrow(/16000/);
  });

  it('setup_complete 一旦为真一直为真，并删掉样本；用户写的算走完', async () => {
    const store = storeAt();
    await store.addSamples('chat', 'agent', [{ text: '先跑测试再合。' }]);
    await store.save('A', { by: 'agent' });
    expect((await store.summary()).files).toBe(1);
    await store.save('A', { by: 'agent', setupComplete: true });
    expect((await store.summary()).files).toBe(0);
    expect((await store.save('B', { by: 'agent' })).profile.setupComplete).toBe(true);
    const other = new WritingStyleStore({ dir: join(tempDir(), 'other') });
    expect((await other.save('U', { by: 'user' })).profile.setupComplete).toBe(true);
  });

  it('删档案连同样本', async () => {
    const store = storeAt();
    await store.save('A', { by: 'agent' });
    await store.addSamples('email', 'team', [{ text: 'Ship it Friday.' }]);
    await store.delete();
    expect(await store.get()).toBeUndefined();
    expect(existsSync(store.samplesDir)).toBe(false);
  });

  it('样本的文件名由 Host 拼：受众、清洗过的来源、日期、序号；单份截断', async () => {
    const store = storeAt();
    const result = await store.addSamples('dm', 'team', [
      { text: 'one', source: '../$(rm -rf ~)/Alice Chen', date: '2026-09-01' },
      { text: 'two', source: '../$(rm -rf ~)/Alice Chen', date: '2026-09-01' },
      { text: 'x'.repeat(SAMPLE_MAX_CHARS + 5), date: 'yesterday' },
      { text: '   ' },
    ]);
    expect(result).toMatchObject({ added: 3, truncated: 1, skipped: 1 });
    expect(readdirSync(join(store.samplesDir, 'dm')).sort()).toEqual([
      'team__misc__2026-10-21__001.txt',
      'team__rm-rf-alice-chen__2026-09-01__001.txt',
      'team__rm-rf-alice-chen__2026-09-01__002.txt',
    ]);
    expect(result.summary.registers).toEqual({ dm: { team: 3 } });
    expect(sampleSlug('李雷')).toBe('misc');
  });

  it('放了太久的样本删掉', async () => {
    let now = new Date('2026-10-21T00:00:00.000Z');
    const store = storeAt(() => now);
    await store.addSamples('chat', 'agent', [{ text: 'a' }]);
    expect(await store.pruneStale()).toBe(false);
    const old = new Date(now.getTime() - SAMPLES_MAX_AGE_MS - 1000);
    utimesSync(store.samplesDir, old, old);
    now = new Date(now.getTime());
    expect(await store.pruneStale()).toBe(true);
    expect(existsSync(store.samplesDir)).toBe(false);
  });

  it('analyze 按落点出统计与范文', async () => {
    const store = storeAt();
    await store.addSamples('chat', 'agent', [
      { text: '先别动配置文件，跑一下测试看看结果再说。', source: 's1', date: '2026-10-01' },
      { text: '好，那就按你说的改，改完直接提交就行。', source: 's1', date: '2026-10-01' },
    ]);
    const result = await store.analyze();
    expect(result?.analysis.provenance).toEqual({ chat: 2 });
    expect(result?.exemplars).toContain('agent — bundle of 2 messages');
  });
});

function seedMessages(storage: Storage, id: SessionId, payloads: object[]) {
  payloads.forEach((payload, index) => {
    storage.events.insert({
      sessionId: id,
      seq: index + 1,
      ts: T0,
      type: (payload as { type?: string }).type ?? 'user.message',
      source: 'host',
      payload,
    });
  });
}

const sentBy = { deviceId: 'dev-1', clientId: 'desktop-1', clientKind: 'desktop' };

describe('collectChatSamples', () => {
  it('只取用户亲手写的文字：不要代发的、粘贴的、代码与斜杠命令', () => {
    const storage = storages.open(tempDir());
    const ses = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
    seedSession(storage, ses);
    seedMessages(storage, ses, [
      {
        turnId: 't1',
        content: [
          { type: 'text', text: '帮我看下这个报错，`npm test` 跑不过：' },
          { type: 'text', text: 'Error: boom\n  at x.js:1', pasted: true },
        ],
        sentBy,
      },
      { turnId: 't2', content: [{ type: 'text', text: '/compact' }], sentBy },
      {
        turnId: 't3',
        content: [{ type: 'text', text: '别的会话发来的' }],
        sentBy,
        from: { sessionId: 'ses_x', kind: 'message' },
      },
      {
        turnId: 't4',
        content: [{ type: 'text', text: '自动化' }],
        sentBy: { ...sentBy, clientId: 'wevir-automations' },
      },
      {
        type: 'user.steered',
        turnId: 't4',
        content: [{ type: 'text', text: '改成先写测试\n```ts\nconst a = 1;\n```' }],
        sentBy,
      },
      { type: 'assistant.message', turnId: 't4', text: 'Agent 的回答' },
    ]);
    const samples = collectChatSamples(storage, { since: new Date('2026-01-01T00:00:00Z') });
    expect(samples.map((sample) => sample.text)).toEqual([
      '改成先写测试',
      '帮我看下这个报错， 跑不过：',
    ]);
    expect(samples[0]).toMatchObject({ source: ses.toLowerCase(), date: T0.slice(0, 10) });
  });

  it('子会话、支线、分支与 Agent 开的会话不看，太旧的不要', () => {
    const storage = storages.open(tempDir());
    const parent = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQ0' as SessionId;
    const forked = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQ1' as SessionId;
    seedSession(storage, parent);
    seedSession(storage, forked);
    storage.db
      .prepare('UPDATE sessions SET forked_from = ? WHERE id = ?')
      .run(JSON.stringify({ sessionId: parent }), forked);
    seedMessages(storage, parent, [
      { turnId: 't1', content: [{ type: 'text', text: '原会话' }], sentBy },
    ]);
    seedMessages(storage, forked, [
      { turnId: 't1', content: [{ type: 'text', text: '原会话' }], sentBy },
    ]);
    expect(collectChatSamples(storage, { since: new Date('2026-01-01T00:00:00Z') })).toHaveLength(
      1,
    );
    expect(collectChatSamples(storage, { since: new Date('2026-12-01T00:00:00Z') })).toHaveLength(
      0,
    );
  });

  it('ownText', () => {
    expect(ownText([{ type: 'text', text: '  ' }])).toBeUndefined();
    expect(ownText([{ type: 'text', text: '/review' }])).toBeUndefined();
    expect(ownText([{ type: 'text', text: '/review 看看这次改动' }])).toBe('/review 看看这次改动');
  });
});

describe('writingStyleTools', () => {
  const call: AppToolCall = {
    sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId,
    signal: new AbortController().signal,
  };
  const text = (result: Awaited<ReturnType<AppTool['call']>>) =>
    (result.content[0] as { text: string }).text;

  function tools(enabled = true) {
    const storage = storages.open(tempDir());
    const store = storeAt();
    const list = writingStyleTools({
      store,
      storage,
      guide: '# 建档步骤',
      enabled: () => enabled,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
    });
    const byName = (name: string) => list.find((tool) => tool.name === name) as AppTool;
    return { store, storage, byName };
  }

  it('四个工具，都标只读（不走批准）', () => {
    const { byName } = tools();
    for (const name of WRITING_STYLE_TOOLS) {
      expect(byName(name).annotations.readOnlyHint).toBe(true);
    }
  });

  it('设置关着时都拒绝', async () => {
    const { byName } = tools(false);
    await expect(byName('wevir_writing_style_read').call({}, call)).rejects.toThrow(
      WRITING_STYLE_OFF_MESSAGE,
    );
  });

  it('setup 返回步骤；read 没有档案时 null', async () => {
    const { byName } = tools();
    expect(text(await byName('wevir_writing_style_setup').call({}, call))).toBe('# 建档步骤');
    expect((await byName('wevir_writing_style_read').call({}, call)).structuredContent).toEqual({
      profile: null,
    });
  });

  it('add → analyze → save(setup_complete) 删掉样本', async () => {
    const { byName, store } = tools();
    const samples = byName('wevir_writing_style_samples');
    await expect(
      samples.call(
        { action: 'add', register: 'email', audience: 'agent', samples: [{ text: 'x' }] },
        call,
      ),
    ).rejects.toThrow(/audience/);
    const added = await samples.call(
      {
        action: 'add',
        register: 'email',
        audience: 'team',
        samples: [
          { text: `${'Short sentences, point first. '.repeat(8)}Thanks.`, source: 'release' },
        ],
      },
      call,
    );
    expect(added.structuredContent).toMatchObject({ added: 1 });
    const analyzed = await samples.call({ action: 'analyze' }, call);
    expect(analyzed.structuredContent).toMatchObject({ usable: true, provenance: { email: 1 } });
    const saved = await byName('wevir_writing_style_save').call(
      { content: '> 来自 1 封邮件。\n\n- 先说结论。', setup_complete: true },
      call,
    );
    expect(saved.structuredContent).toMatchObject({
      saved: true,
      setupComplete: true,
      samplesDeleted: true,
    });
    expect((await store.summary()).files).toBe(0);
    expect(
      (await byName('wevir_writing_style_read').call({}, call)).structuredContent,
    ).toMatchObject({ profile: '> 来自 1 封邮件。\n\n- 先说结论。', editedByUser: false });
  });

  it('像密钥的内容不存', async () => {
    const { byName } = tools();
    await expect(
      byName('wevir_writing_style_save').call(
        { content: '落款带 sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
        call,
      ),
    ).rejects.toThrow(/secret/);
  });

  it('analyze 没有能用的样本时 usable: false', async () => {
    const { byName } = tools();
    const result = await byName('wevir_writing_style_samples').call({ action: 'analyze' }, call);
    expect(result.structuredContent).toMatchObject({ usable: false });
  });
});
