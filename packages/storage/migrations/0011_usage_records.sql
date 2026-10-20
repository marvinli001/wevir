-- 0011_usage_records：用量统计（协议 0.62.0）。每次模型请求一行，引擎的 `usage.recorded` 写进来。
--
-- 不进事件流，也不随会话删除：会话删了，统计里的用量还在（session_id 不设外键）。(session_id, request_id) 唯一，同一请求重复
-- 上报只记第一次。provider_name 存记录时 Provider 的显示名，Provider 删了也能显示。时间是 Unix 毫秒，便于按客户端给的分桶聚合。
-- 成本不存：查询时按当前的价格表算（价格表在数据目录里，每天从 models.dev 刷新）。
CREATE TABLE usage_records (
  id               INTEGER PRIMARY KEY,
  session_id       TEXT    NOT NULL,
  request_id       TEXT    NOT NULL,
  at               INTEGER NOT NULL,
  source           TEXT    NOT NULL,
  provider_id      TEXT    NOT NULL,
  provider_name    TEXT    NOT NULL,
  upstream         TEXT,
  model            TEXT    NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  duration_ms      INTEGER,
  first_token_ms   INTEGER,
  UNIQUE (session_id, request_id)
) STRICT;

CREATE INDEX usage_records_at ON usage_records (at);
