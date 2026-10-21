import type { HostFeatures, ProfileItem, ProfileLayer } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  changesSummary,
  itemDetail,
  itemLabel,
  knownLayers,
  layerManage,
  layerName,
  layerScopes,
  layerSummary,
  pendingSummary,
  pickScope,
  resolveTuningTab,
  scopeWorkspaceId,
  shortHash,
  textHashOf,
  tuningAvailability,
} from './tuning-model';

const HASH = 'a'.repeat(64);
const item = (patch: Partial<ProfileItem> = {}): ProfileItem => ({
  id: 'AGENTS.md',
  label: 'AGENTS.md',
  scope: 'project',
  hash: HASH,
  ...patch,
});
const layer = (key: string, items: ProfileItem[] = []): ProfileLayer => ({
  key,
  hash: HASH,
  items,
});
const features: HostFeatures = { tuning: true };

describe('tuning-model', () => {
  it('功能与分段', () => {
    expect(tuningAvailability(undefined)).toBe('pending');
    expect(tuningAvailability({})).toBe('unsupported');
    expect(tuningAvailability(features)).toBe('ready');
    expect(resolveTuningTab('profile', features)).toEqual({ tab: 'profile', redirect: false });
    expect(resolveTuningTab(undefined, features)).toEqual({ tab: 'profile', redirect: true });
    expect(resolveTuningTab('trials', features)).toEqual({ tab: 'profile', redirect: true });
  });

  it('范围：地址优先，其次上次的，都不在时是全局', () => {
    expect(pickScope('ws_b', 'ws_a', ['ws_a', 'ws_b'])).toBe('ws_b');
    expect(pickScope(null, 'ws_a', ['ws_a'])).toBe('ws_a');
    expect(pickScope('ws_gone', 'ws_gone', ['ws_a'])).toBe('global');
    expect(pickScope('global', 'ws_a', ['ws_a'])).toBe('global');
    expect(scopeWorkspaceId('global')).toBeUndefined();
    expect(scopeWorkspaceId('ws_a')).toBe('ws_a');
  });

  it('层：按固定顺序、只留认得的，摘要与范围', () => {
    const layers = [layer('memory'), layer('future'), layer('system')];
    expect(knownLayers(layers).map((entry) => entry.key)).toEqual(['system', 'memory']);
    expect(layerName('future')).toBe('future');
    expect(layerName('rules')).toBe('规则文件');
    expect(layerSummary(layer('rules', [item(), item({ id: 'CLAUDE.md' })]))).toBe('2 个文件');
    expect(layerSummary(layer('memory', [item()]))).toBe('1 条');
    expect(
      layerSummary(layer('instructions', [item({ id: 'outputStyle', detail: 'concise' })])),
    ).toBe('简洁');
    expect(layerScopes(layer('rules', [item(), item({ scope: 'global' })]))).toBe('全局 · 项目');
    expect(layerScopes(layer('rules'))).toBe('');
  });

  it('条目：说明与风格用界面上的叫法，记忆不显示种类', () => {
    expect(itemLabel('instructions', item({ id: 'agentInstructions' }))).toBe('给 Agent 的说明');
    expect(itemDetail('instructions', item({ id: 'outputStyle', detail: 'my-style' }))).toBe(
      'my-style',
    );
    expect(itemDetail('memory', item({ detail: 'feedback' }))).toBeUndefined();
    expect(itemDetail('connectors', item({ detail: 'npx' }))).toBe('npx');
    expect(shortHash(HASH)).toBe('aaaaaaaa');
  });

  it('变化摘要与待生效', () => {
    expect(
      changesSummary([
        { key: 'rules', added: 0, removed: 0, modified: 1 },
        { key: 'memory', added: 2, removed: 1, modified: 0 },
        { key: 'future', added: 1, removed: 0, modified: 0 },
      ]),
    ).toBe('规则文件 · 记忆 +2 −1');
    expect(changesSummary(undefined)).toBe('');
    expect(pendingSummary(['rules', 'memory', 'future'])).toBe('规则文件、记忆');
  });

  it('管理入口与文本散列', () => {
    expect(layerManage('memory')).toEqual({ kind: 'settings', tab: 'memory' });
    expect(layerManage('skills')).toEqual({ kind: 'plugins', tab: 'skills' });
    expect(layerManage('rules')).toBeUndefined();
    expect(textHashOf(item())).toBeUndefined();
    expect(textHashOf(item({ text: true }))).toBe(HASH);
    expect(textHashOf(item({ text: true, textHash: 'b'.repeat(64) }))).toBe('b'.repeat(64));
  });
});
