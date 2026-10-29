import type { SqliteDatabase, SqlRow } from './driver.js';
import { changed, json, optionalJson, optionalText, text, toJson, toNullableJson } from './rows.js';

/**
 * `provider_profiles` 表的一行。密钥不在这里：`secretRef` 是 `SecretStore` 的键（ADR-0003 决策 3），
 * 不上线缆；线缆上的 `hasSecret` 由 Host 按它是否存在得出。
 */
export interface ProviderProfileRecord {
  id: string;
  kind: string;
  displayName: string;
  api?: string;
  baseURL?: string;
  /** protocol `ProviderCompat`，原样存 JSON。 */
  compat?: unknown;
  /** Vertex project / location，服务账号 JSON 不在数据库里。 */
  vertex?: { project: string; location?: string };
  /** protocol `ProviderModel[]`，原样存 JSON。 */
  models: unknown;
  /** protocol `ProviderTranscriptionModel[]`（0021，协议 0.92.0），原样存 JSON；省略表示没有。 */
  transcriptionModels?: unknown;
  /** protocol `ProviderImageModel[]`（0028，协议 0.139.0），原样存 JSON；省略表示没有。 */
  imageModels?: unknown;
  defaultModelId: string;
  secretRef?: string;
  /** 停用（0007，协议 0.19.0 的 `provider.setEnabled`）；省略表示启用。 */
  enabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderProfileRepository {
  /** 插入新 Profile；`id` 已存在时抛主键约束错误。 */
  insert(record: ProviderProfileRecord): void;
  /** 更新可变字段；`id`、`kind`、`createdAt` 不变（domain-model §3.2）。不存在时返回 false。 */
  update(record: ProviderProfileRecord): boolean;
  get(id: string): ProviderProfileRecord | undefined;
  /** 按创建时间排序。 */
  list(): ProviderProfileRecord[];
  delete(id: string): boolean;
}

export function createProviderProfileRepository(db: SqliteDatabase): ProviderProfileRepository {
  const insert = db.prepare(`
    INSERT INTO provider_profiles (
      id, kind, display_name, api, base_url, compat, models, default_model_id, secret_ref,
      enabled, vertex, transcription_models, image_models, created_at, updated_at
    ) VALUES (
      :id, :kind, :displayName, :api, :baseURL, :compat, :models, :defaultModelId, :secretRef,
      :enabled, :vertex, :transcriptionModels, :imageModels, :createdAt, :updatedAt
    )`);
  const update = db.prepare(`
    UPDATE provider_profiles SET
      display_name = :displayName, api = :api, base_url = :baseURL, compat = :compat,
      models = :models, default_model_id = :defaultModelId, secret_ref = :secretRef,
      enabled = :enabled, vertex = :vertex, transcription_models = :transcriptionModels,
      image_models = :imageModels, updated_at = :updatedAt
    WHERE id = :id`);
  const get = db.prepare('SELECT * FROM provider_profiles WHERE id = ?');
  const list = db.prepare('SELECT * FROM provider_profiles ORDER BY created_at, id');
  const remove = db.prepare('DELETE FROM provider_profiles WHERE id = ?');

  function mutableParams(record: ProviderProfileRecord) {
    return {
      id: record.id,
      displayName: record.displayName,
      api: record.api ?? null,
      baseURL: record.baseURL ?? null,
      compat: toNullableJson(record.compat),
      vertex: toNullableJson(record.vertex),
      models: toJson(record.models),
      transcriptionModels: toNullableJson(record.transcriptionModels),
      imageModels: toNullableJson(record.imageModels),
      defaultModelId: record.defaultModelId,
      secretRef: record.secretRef ?? null,
      enabled: record.enabled === false ? 0 : 1,
      updatedAt: record.updatedAt,
    };
  }

  return {
    insert(record) {
      insert.run({ ...mutableParams(record), kind: record.kind, createdAt: record.createdAt });
    },
    update: (record) => changed(update.run(mutableParams(record))),
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    list: () => list.all().map(fromRow),
    delete: (id) => changed(remove.run(id)),
  };
}

function fromRow(row: SqlRow): ProviderProfileRecord {
  const record: ProviderProfileRecord = {
    id: text(row, 'id'),
    kind: text(row, 'kind'),
    displayName: text(row, 'display_name'),
    models: json(row, 'models'),
    defaultModelId: text(row, 'default_model_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const api = optionalText(row, 'api');
  if (api !== undefined) record.api = api;
  const baseURL = optionalText(row, 'base_url');
  if (baseURL !== undefined) record.baseURL = baseURL;
  const compat = optionalJson(row, 'compat');
  if (compat !== undefined) record.compat = compat;
  const vertex = optionalJson(row, 'vertex');
  if (vertex !== undefined) record.vertex = vertex as ProviderProfileRecord['vertex'];
  const transcriptionModels = optionalJson(row, 'transcription_models');
  if (transcriptionModels !== undefined) record.transcriptionModels = transcriptionModels;
  const imageModels = optionalJson(row, 'image_models');
  if (imageModels !== undefined) record.imageModels = imageModels;
  const secretRef = optionalText(row, 'secret_ref');
  if (secretRef !== undefined) record.secretRef = secretRef;
  if (row.enabled === 0 || row.enabled === 0n) record.enabled = false;
  return record;
}
