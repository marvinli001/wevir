-- 0023_devices：配对过的远程设备（协议 0.107.0 的 device.* 与 pairing.*，domain-model §3.49，ADR-0017 §3）。
--
-- 设备的身份是它的 Noise 静态公钥（X25519，base64url）。同一个公钥同时只有一条 active 的记录；移除（revoked）的留着，重新配对得到
-- 新的一条。推送令牌不在库里：`push_token_ref` 指向 secrets.json 里的条目（ADR-0003），移除时一并删掉。
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  platform       TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  -- JSON 数组：这台设备的权限。
  permissions    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  push_token_ref TEXT,
  status         TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) STRICT;

CREATE UNIQUE INDEX devices_active_public_key ON devices (public_key) WHERE status = 'active';
