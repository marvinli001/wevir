-- 0001_init：骨架阶段的初始表结构（T2.1）。字段含义见 docs/architecture/domain-model.md §3。
--
-- 约定：
-- - 时间列是 ISO 8601 UTC 毫秒文本（Date#toISOString），可直接按字典序比较。
-- - 枚举列（kind、state、status、source 等）不加 CHECK：协议的枚举只增不减，而 SQLite 改 CHECK
--   要重建表；取值由 Host 保证。JSON 列加 json_valid 检查。
-- - 所有表 STRICT：列类型不符直接报错，不做隐式转换。

-- 工作区。workspace.remove 只注销（removed_at），不删行；同一 root_path 再次添加时清空 removed_at，
-- 恢复原 id 与历史（domain-model §3.1）。
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  root_path     TEXT NOT NULL UNIQUE,  -- 目录的 realpath，按它去重
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  removed_at    TEXT
) STRICT;

-- 模型服务配置。密钥不进数据库：secret_ref 是 SecretStore 的键（ADR-0003 决策 3），NULL 表示没有 Key。
CREATE TABLE provider_profiles (
  id                TEXT PRIMARY KEY,  -- ProviderId，也是 dsh 的路由名，创建后不可改
  kind              TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  api               TEXT,
  base_url          TEXT,
  compat            TEXT CHECK (compat IS NULL OR json_valid(compat)),
  models            TEXT NOT NULL CHECK (json_valid(models)),
  default_model_id  TEXT NOT NULL,
  secret_ref        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;

-- 会话。身份列创建后不变；其余列是由事件推导的缓存，供会话列表使用，与事件不一致时以事件为准
-- （domain-model §3.3）。provider_id 不加外键：已关闭会话引用的 Provider 可以删除（§3.2）。
CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces (id),
  cwd                TEXT NOT NULL,
  engine             TEXT NOT NULL,  -- 引擎种类，v0 恒为 dsh
  engine_session_id  TEXT NOT NULL,  -- 引擎会话 ID（ACP sessionId）
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  reasoning_effort   TEXT,
  title              TEXT NOT NULL,
  title_source       TEXT NOT NULL,
  state              TEXT NOT NULL,
  active_turn        TEXT CHECK (active_turn IS NULL OR json_valid(active_turn)),
  last_error         TEXT CHECK (last_error IS NULL OR json_valid(last_error)),
  last_seq           INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (engine, engine_session_id)  -- Wevir 会话与引擎会话一一对应（domain-model §1.1）
) STRICT;

CREATE INDEX sessions_by_workspace ON sessions (workspace_id, updated_at);

-- 会话事件，只追加。seq 在会话内从 1 开始连续，由事件库分配（T2.2）。
CREATE TABLE events (
  session_id  TEXT NOT NULL REFERENCES sessions (id),
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  source      TEXT NOT NULL,
  payload     TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

-- 审批。状态只由审批状态机修改（domain-model §5）。decided_by 是做出决定的客户端
-- （ClientIdentity JSON），只有 resolution_reason 为 user 时有。
CREATE TABLE approvals (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions (id),
  turn_id               TEXT NOT NULL,
  tool_call_id          TEXT NOT NULL,
  options               TEXT NOT NULL CHECK (json_valid(options)),
  detail                TEXT NOT NULL CHECK (json_valid(detail)),  -- 找不到 tool.started 时为 JSON null
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  resolution_reason     TEXT,
  resolution_option_id  TEXT,
  decided_by            TEXT CHECK (decided_by IS NULL OR json_valid(decided_by))
) STRICT;

CREATE INDEX approvals_by_session ON approvals (session_id, status);

-- session.send 的 clientMessageId 回执（ADR-0002 §4，host-api.md session.send）。只记被接受的发送：
-- 同一 ID 重发时比对 fingerprint，相同则返回原结果（turn_id、seq），不同则 CLIENT_MESSAGE_CONFLICT。
-- status：accepted（已接受、未确认引擎收到）、confirmed（引擎已收到）、unknown（Host 重启时仍是
-- accepted，结果未知，不自动重发）。
CREATE TABLE send_receipts (
  session_id         TEXT NOT NULL REFERENCES sessions (id),
  client_message_id  TEXT NOT NULL,
  fingerprint        TEXT NOT NULL,
  status             TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  seq                INTEGER NOT NULL,  -- 这次发送的 user.message 的 seq
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (session_id, client_message_id)
) STRICT, WITHOUT ROWID;
