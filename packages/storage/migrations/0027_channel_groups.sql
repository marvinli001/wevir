-- 0027_channel_groups：助理之间的消息与助理群（协议 0.132.0）。
--
-- 群是 `kind = 'group'` 的频道：没有自己的工作区、协调者与预算（`workspace_id` 存空串，`coordinator`、`budget` 存 JSON null），
-- 成员存在 `group_info`（JSON：`{ members }`）。帖子的 `meta`（JSON）放 Host 自用的附加信息：发给哪个助理（`to`）、@ 了谁
-- （`mentions`）、助理之间来回的层数（`depth`）、回答要送回哪里（`origin`）。
ALTER TABLE channels ADD COLUMN group_info TEXT;
ALTER TABLE channel_posts ADD COLUMN meta TEXT;
