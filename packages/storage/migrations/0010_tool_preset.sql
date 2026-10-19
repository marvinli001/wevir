-- 0010_tool_preset：会话的工具预设（Wevir 应用级工具给模型看哪些组）。
--
-- tool_preset 是 { id, groups? } 的 JSON（id 是 full 或 core，groups 是在 core 之上另加的组），建会话时写，之后不变；NULL 表示
-- 没有选，等同 full（这一列之前建的会话都是）。只管 Host 的应用级工具，不管引擎自带的工具与用户接入的 MCP。
ALTER TABLE sessions ADD COLUMN tool_preset TEXT;
