import { describe, expect, it } from 'vitest';
import { lowestEffort, TitleCollector } from './title.js';

describe('lowestEffort', () => {
  it('取模型支持的最低一档，off 换成 Codex 的 none；不推理的模型没有', () => {
    expect(lowestEffort({ id: 'm', reasoningEfforts: ['high', 'low', 'medium'] })).toBe('low');
    expect(lowestEffort({ id: 'm', reasoningEfforts: ['max', 'off'] })).toBe('none');
    expect(lowestEffort({ id: 'm', reasoningEfforts: [] })).toBeUndefined();
    expect(lowestEffort({ id: 'm' })).toBeUndefined();
  });
});

describe('TitleCollector', () => {
  it('取最后一条已提交的助手消息，回合完成时给出', async () => {
    const collector = new TitleCollector();
    collector.onNotification('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"a"}' },
    });
    collector.onNotification('turn/completed', { turn: { status: 'completed' } });
    await expect(collector.done).resolves.toBe('{"title":"a"}');
  });

  it('回合失败或中断时报错', async () => {
    const collector = new TitleCollector();
    collector.onNotification('turn/completed', {
      turn: { status: 'failed', error: { message: 'boom' } },
    });
    await expect(collector.done).rejects.toMatchObject({ code: 'engine_unavailable' });
  });
});
