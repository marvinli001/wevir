-- 0020_tuning_proposals：调优的建议（协议 0.87.0 的 tuning.proposal.*）。
--
-- 用户在某个会话上点“生成建议”时模型提出的配置改动，一行一条。workspace_id 是会话所在的项目；session_id 是提出它的会话，会话删了
-- 之后建议还在。kind 是 rule、skill、memory、guardrail；target 是给人看的目标。base_hash 是生成时目标的散列，采纳前比对，变了就是
-- stale。payload_json 是改动（协议的 TuningProposalChange，加上 edited），evidence_json 是证据，usage_json 是生成它的那次操作的
-- 用量与模型。status 是 pending、stale、accepted、rejected。version_id 是采纳之后下一个会话开的档案版本。
CREATE TABLE tuning_proposals (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  target        TEXT NOT NULL,
  base_hash     TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status        TEXT NOT NULL,
  usage_json    TEXT,
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  version_id    TEXT
) STRICT;

CREATE INDEX tuning_proposals_workspace ON tuning_proposals (workspace_id, status, created_at);
