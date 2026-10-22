-- 0022_inbox_dismissals：收件箱里收起的项（协议 0.105.0 的 inbox.dismiss，domain-model §3.47）。
--
-- 收件箱本身不存，Host 启动时从事件、审批表与自动化的运行重建；这里只记用户收起过的失败回合与自动化项（`turn_failed:<回合 ID>`、
-- `automation:<运行 ID>`），重建后减去它们。重建时已不可能再出现的项的记录一并删掉。
CREATE TABLE inbox_dismissals (
  item_id      TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL
) STRICT;
