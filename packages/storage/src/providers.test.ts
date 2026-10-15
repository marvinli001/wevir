import { describe, expect, it } from 'vitest';
import type { ProviderProfileRecord } from './providers.js';
import { T0, T1, useTempStorage } from './test-utils.js';

const official: ProviderProfileRecord = {
  id: 'deepseek-official',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [],
  defaultModelId: 'deepseek-chat',
  createdAt: T0,
  updatedAt: T0,
};

const compatible: ProviderProfileRecord = {
  id: 'local-llm',
  kind: 'openai-compatible',
  displayName: '本机模型',
  api: 'openai-completions',
  baseURL: 'http://127.0.0.1:11434/v1',
  compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  models: [{ id: 'qwen3', contextWindow: 131072 }],
  defaultModelId: 'qwen3',
  secretRef: 'provider:local-llm',
  createdAt: T1,
  updatedAt: T1,
};

describe('provider_profiles', () => {
  const { storage } = useTempStorage();

  it('Vertex 的非密钥配置随插入与修改往返', () => {
    const repo = storage().providers;
    const record = {
      ...compatible,
      kind: 'google-vertex',
      vertex: { project: 'vertex-example', location: 'global' },
    };
    repo.insert(record);
    expect(repo.get(record.id)).toEqual(record);
    repo.update({ ...record, vertex: { project: 'other-project', location: 'us' } });
    expect(repo.get(record.id)?.vertex).toEqual({ project: 'other-project', location: 'us' });
  });

  it('插入与读取，可选字段与 JSON 字段原样往返', () => {
    const repo = storage().providers;
    repo.insert(official);
    repo.insert(compatible);
    expect(repo.get('deepseek-official')).toEqual(official);
    expect(repo.get('local-llm')).toEqual(compatible);
    expect(repo.list().map((p) => p.id)).toEqual(['deepseek-official', 'local-llm']);
  });

  it('id 唯一', () => {
    const repo = storage().providers;
    repo.insert(official);
    expect(() => repo.insert(official)).toThrow(/UNIQUE constraint failed: provider_profiles\.id/);
  });

  it('更新可变字段，kind 与 createdAt 不变；可清空可选字段', () => {
    const repo = storage().providers;
    repo.insert(compatible);
    const { compat: _compat, secretRef: _secretRef, ...rest } = compatible;
    const updated = { ...rest, kind: 'deepseek-official', createdAt: T1, displayName: '改名' };
    expect(repo.update({ ...updated, updatedAt: '2026-10-13T00:00:05.000Z' })).toBe(true);
    expect(repo.get('local-llm')).toEqual({
      ...rest,
      displayName: '改名',
      updatedAt: '2026-10-13T00:00:05.000Z',
    });
    expect(repo.update({ ...official, id: 'missing' })).toBe(false);
  });

  it('删除', () => {
    const repo = storage().providers;
    repo.insert(official);
    expect(repo.delete('deepseek-official')).toBe(true);
    expect(repo.delete('deepseek-official')).toBe(false);
    expect(repo.get('deepseek-official')).toBeUndefined();
  });

  it('表里只有 secret_ref，没有存密钥的列', () => {
    const columns = storage()
      .db.prepare('PRAGMA table_info(provider_profiles)')
      .all()
      .map((row) => row.name);
    expect(columns).toEqual([
      'id',
      'kind',
      'display_name',
      'api',
      'base_url',
      'compat',
      'models',
      'default_model_id',
      'secret_ref',
      'created_at',
      'updated_at',
      'enabled',
      'vertex',
    ]);
  });

  it('启用开关（0007）：省略即启用，停用存取一致，更新时可改回', () => {
    const repo = storage().providers;
    repo.insert(compatible);
    expect(repo.get('local-llm')?.enabled).toBeUndefined();
    repo.update({ ...compatible, enabled: false });
    expect(repo.get('local-llm')).toEqual({ ...compatible, enabled: false });
    repo.update(compatible);
    expect(repo.get('local-llm')).toEqual(compatible);
  });

  it('JSON 列拒绝非法 JSON', () => {
    expect(() =>
      storage()
        .db.prepare(
          "INSERT INTO provider_profiles (id, kind, display_name, models, default_model_id, created_at, updated_at) VALUES ('x', 'k', 'd', 'not json', 'm', 't', 't')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
