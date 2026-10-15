-- 0005_session_origin：会话的来源（U23，协议 0.16.0）。字段含义见 docs/architecture/domain-model.md §3.11。
--
-- origin 是 SessionOrigin 的 JSON（现在只有 suggested_task：提出建议的会话与建议的 ID），建会话时写，之后不变；
-- 普通会话是 NULL。建议本身不另建表，由提出建议的会话的事件（tasks.suggested、task.started、task.reported）推导。
ALTER TABLE sessions ADD COLUMN origin TEXT;
