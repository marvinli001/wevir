/** 仅限进程内；原值不能进入协议、设置文件或日志。 */
export interface GatewayPrivacySettings {
  enabled?: boolean;
  excludedValueHashes?: readonly string[];
  excludedPatterns?: readonly string[];
}

export interface GatewayPrivacySource {
  settings(): GatewayPrivacySettings | undefined;
  secrets(): readonly string[] | Promise<readonly string[]>;
}
