-- 0029_session_fast：会话的快速模式（协议 0.148.0）。字段含义见 docs/architecture/domain-model.md §3.3。
--
-- 1 表示快速模式；之前建的会话是标准速度（NULL）。与 reasoning_effort 一样是 session.created / session.configured 推导的缓存。
ALTER TABLE sessions ADD COLUMN fast INTEGER CHECK (fast IS NULL OR fast = 1);
