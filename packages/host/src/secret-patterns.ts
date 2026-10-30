// 像密钥的内容的检查与遮盖在 `@wevir/runtime-adapter`（引擎适配器也要用），这里转出给 Host 的模块。

export {
  looksLikeSecret,
  REDACTED,
  redactDiagnostics,
  redactSecrets,
  SECRET_PATTERNS,
} from '@wevir/runtime-adapter';
