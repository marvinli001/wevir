-- 0007_provider_enabled：Provider 的启用开关（协议 0.19.0 的 provider.setEnabled）。字段含义见
-- docs/architecture/domain-model.md §3.2。
--
-- 1 启用、0 停用；之前建的 Provider 都是启用。停用只影响客户端的模型选择，Host 照常用它跑已有会话。
ALTER TABLE provider_profiles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
