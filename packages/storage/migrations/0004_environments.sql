-- 0004_environments：保存的环境与环境会话的目录（U22.1，协议 0.15.0）。字段含义见 docs/architecture/domain-model.md §3.10。
--
-- environments.folders 是 EnvironmentFolder[] 的 JSON（按顺序，第一个是主文件夹）；location 现在只有 local。
-- sessions 的三列建会话时写，之后不变，同 session.created 事件里的同名字段；普通会话都是 NULL。
CREATE TABLE environments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  location   TEXT NOT NULL,
  folders    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE sessions ADD COLUMN environment_id TEXT;
ALTER TABLE sessions ADD COLUMN extra_roots TEXT;
ALTER TABLE sessions ADD COLUMN worktrees TEXT;
