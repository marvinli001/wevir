// 验更新清单签名的公钥（ADR-0007 补记 4），SPKI DER 的 base64。任何一把验过就算通过；轮换时先把新公钥加进来发一版，之后
// 再用新私钥签、再删掉旧的。私钥不进仓库（scripts/update-signing.ts）。
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  // 2026-10-16 生成，私钥在维护者本机（~/.wevir-release/update-signing-key.pem），发布流水线用 secret。
  'MCowBQYDK2VwAyEAEnVyt1ks2OE3nc84Mffo4zTOl8iRtPnJhjXuUcx/yjc=',
];
