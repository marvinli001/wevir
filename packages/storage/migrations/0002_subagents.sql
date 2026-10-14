-- 0002_subagents：子会话（R4）。字段含义见 docs/architecture/domain-model.md §3.3.1。
--
-- 引擎派出的子 agent 是父会话下的子会话：parent_session_id 是父会话，parent_tool_call_id 是父会话里派出它的工具调用。
-- 两列都是身份列，Host 建子会话时写入，之后不变；普通会话两列都是 NULL。子会话不进默认的会话列表，也不算挡住工作区
-- 移除与 Provider 删除的“未关闭会话”（它们跟着父会话走）。
ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions (id);
ALTER TABLE sessions ADD COLUMN parent_tool_call_id TEXT;

CREATE INDEX sessions_by_parent ON sessions (parent_session_id, created_at);
