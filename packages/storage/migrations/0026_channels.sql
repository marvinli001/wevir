-- 0026_channels：频道与助理（协议 0.120.0 的 channel.*，domain-model §3.53，ADR-0020 §2）。
--
-- 频道是一条时间线加一个常驻的协调者会话；时间线的帖子存在这里，不进事件库（时间线不属于任何一个会话，协调者会换班）。
-- 帖子只追加：之后只改 `routed_to`（转给了哪些线程）与 `card`（建议卡片的采纳状态）。删频道是软删（`deleted_at`）。
-- 线程是顶层会话，`channel_threads` 只记频道附加的部分，其余由会话推导。读过到哪按读者（`local` 或设备）记；预算按本机时区的
-- 自然日记协调者的唤醒次数与 token。
CREATE TABLE channels (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  title            TEXT NOT NULL,
  -- 助理的身份与规矩（JSON）；项目频道为 NULL。
  assistant        TEXT,
  coordinator      TEXT NOT NULL,
  budget           TEXT NOT NULL,
  paused_at        TEXT,
  pause_reason     TEXT,
  last_post_seq    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
) STRICT;

CREATE UNIQUE INDEX channels_project_workspace ON channels (workspace_id)
  WHERE kind = 'project' AND deleted_at IS NULL;

CREATE TABLE channel_posts (
  channel_id     TEXT NOT NULL REFERENCES channels (id),
  seq            INTEGER NOT NULL,
  id             TEXT NOT NULL UNIQUE,
  author         TEXT NOT NULL,
  content        TEXT NOT NULL,
  reply_to       TEXT,
  routed_to      TEXT,
  card           TEXT,
  files          TEXT,
  client_post_id TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (channel_id, seq)
) STRICT;

CREATE UNIQUE INDEX channel_posts_client ON channel_posts (channel_id, client_post_id)
  WHERE client_post_id IS NOT NULL;

CREATE TABLE channel_threads (
  session_id   TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES channels (id),
  root_post_id TEXT NOT NULL,
  opened_by    TEXT NOT NULL,
  resolved_at  TEXT,
  resolved_by  TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX channel_threads_channel ON channel_threads (channel_id, created_at);

CREATE TABLE channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels (id),
  reader     TEXT NOT NULL,
  seen_seq   INTEGER NOT NULL,
  PRIMARY KEY (channel_id, reader)
) STRICT;

CREATE TABLE channel_usage (
  channel_id TEXT NOT NULL REFERENCES channels (id),
  day        TEXT NOT NULL,
  wakes      INTEGER NOT NULL DEFAULT 0,
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, day)
) STRICT;
