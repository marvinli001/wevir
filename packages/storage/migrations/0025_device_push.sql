-- 0025_device_push：设备的推送（协议 0.112.0，domain-model §3.52，ADR-0017 §6 与补记 6）。
--
-- push_enabled 是这台设备的推送开关（配对时问一次，之后在设备页改；旧设备是 0）。push_counter 是给这台设备加密推送用的计数，只增
-- 不减：同一把推送密钥下不能重复。推送令牌仍在 secrets.json（push_token_ref），不在库里。
ALTER TABLE devices ADD COLUMN push_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN push_counter INTEGER NOT NULL DEFAULT 0;
