-- 0019_profile_versions：调优的档案版本（协议 0.85.0 的 tuning.*）。
--
-- workspace_id 为 NULL 是全局档案（不在项目里的对话用），否则是这个项目的。seq 是范围内的序号，从 1 起。fingerprint 是八个层散列
-- 合起来的 sha256；同一范围里配置改回以前的样子时开新版本、不复用旧的，所以指纹不唯一。manifest_json 是每层的条目与层散列。
-- cause_json 记这一版由什么产生（以后的建议采纳），NULL 是会话开始时自动生成的。
-- sessions.profile_version_id 是建会话时用的版本。
CREATE TABLE profile_versions (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT,
  seq           INTEGER NOT NULL,
  fingerprint   TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  cause_json    TEXT
) STRICT;

CREATE UNIQUE INDEX profile_versions_seq ON profile_versions (COALESCE(workspace_id, ''), seq);

ALTER TABLE sessions ADD COLUMN profile_version_id TEXT;

CREATE INDEX sessions_profile_version ON sessions (profile_version_id) WHERE profile_version_id IS NOT NULL;
