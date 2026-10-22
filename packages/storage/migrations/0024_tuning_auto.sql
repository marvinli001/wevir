-- 0024_tuning_auto：自动调优（协议 0.108.0，domain-model §3.50，ADR-0018）。
--
-- tuning_proposals 加 origin（user 用户点的生成、auto 后台生成、agent 的 wevir_tuning_propose；旧行是 user）与 outcome_json（试用的
-- 结论，协议的 TuningTrialOutcome）。status 多了 trial（已写入、在试用）与 reverted（回退或撤销，目标已恢复）。采纳写入后改后内容的散列
-- （applied）放在 payload_json 里。
ALTER TABLE tuning_proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
ALTER TABLE tuning_proposals ADD COLUMN outcome_json TEXT;

-- tuning_runs：每次调模型生成建议（自动与手动都记，agent 提交不调模型、不记），不管有没有产出。本月的消耗按它求和，后台生成的上限
-- 只算 origin = 'auto' 的。usage_json 是 {inputTokens, outputTokens}；proposals 是进入试用的条数；reason 是没生成时的原因。
CREATE TABLE tuning_runs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  origin       TEXT NOT NULL,
  usage_json   TEXT,
  proposals    INTEGER NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE INDEX tuning_runs_created ON tuning_runs (created_at);
CREATE INDEX tuning_runs_workspace ON tuning_runs (workspace_id, created_at);
CREATE INDEX tuning_runs_session ON tuning_runs (session_id, created_at);
