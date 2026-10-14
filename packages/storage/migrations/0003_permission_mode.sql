-- 0003_permission_mode：会话的权限模式（U15，协议 0.11.0）。字段含义见 docs/architecture/domain-model.md §3.9。
--
-- on_request / auto_review / full_access；NULL 表示 on_request（这一列之前建的会话都是）。同 model_id、reasoning_effort，
-- 是由 session.created / session.configured 事件推导的缓存，与事件不一致时以事件为准。
ALTER TABLE sessions ADD COLUMN permission_mode TEXT;
