-- 0009_session_archive：会话归档（协议 0.23.0 的 session.archive）。字段含义见 docs/architecture/domain-model.md §3.3。
--
-- 归档的时刻；NULL 表示没有归档。归档的会话已关闭，session.list 默认不列，带 archived: true 时只列它们。
ALTER TABLE sessions ADD COLUMN archived_at TEXT;
