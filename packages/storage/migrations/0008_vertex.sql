-- Vertex 的非密钥配置；服务账号整份 JSON 仍只在 SecretStore。
ALTER TABLE provider_profiles ADD COLUMN vertex TEXT CHECK (vertex IS NULL OR json_valid(vertex));
