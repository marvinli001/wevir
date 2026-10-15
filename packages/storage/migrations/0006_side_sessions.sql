-- 0006_side_sessions：支线会话（U23.1，协议 0.17.0）。字段含义见 docs/architecture/domain-model.md §3.12。
--
-- forked_from 是 { sessionId, turnId? } 的 JSON；side 为 1 表示支线会话，普通会话都是 NULL。两列建会话时写，之后不变。
-- 支线不进会话列表，也不挡移除工作区与 Provider（它们在界面上看不到，没法让用户先关掉）。
ALTER TABLE sessions ADD COLUMN forked_from TEXT;
ALTER TABLE sessions ADD COLUMN side INTEGER;
