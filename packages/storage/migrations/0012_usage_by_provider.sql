-- 0012_usage_by_provider：用量记录归属于 Provider（模型服务里添加的订阅或 API 连接）。
--
-- 删 Provider 时 Host 一并删它的用量记录（provider_id 上加索引）；之前删掉的 Provider 留下的记录在这里清掉。会话删了记录仍在。
CREATE INDEX usage_records_provider ON usage_records (provider_id);

DELETE FROM usage_records WHERE provider_id NOT IN (SELECT id FROM provider_profiles);
