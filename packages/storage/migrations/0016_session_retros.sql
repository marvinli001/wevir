-- 0016_session_retros：任务回顾（协议 0.76.0 的 retro.*，ADR-0012）。
--
-- session_retros 是会话事件的投影：版本是 (session_id, through_seq, schema_version)，state 是归约状态的 JSON，全部能从事件重建；
-- 读出来解析不了、形状不对或 schema_version 不同时 Host 从头重放。session_retro_summaries 是用户触发的模型摘要：不是投影，
-- 不能从事件重建，丢了只是没有摘要；每个会话留最近一份。两张表都随会话删除（sessions.remove）。
CREATE TABLE session_retros (
  session_id     TEXT PRIMARY KEY REFERENCES sessions (id),
  schema_version INTEGER NOT NULL,
  through_seq    INTEGER NOT NULL,
  state          TEXT NOT NULL,
  built_at       TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE session_retro_summaries (
  session_id   TEXT PRIMARY KEY REFERENCES sessions (id),
  summary      TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;
