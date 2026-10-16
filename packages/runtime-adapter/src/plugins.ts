// Host 与引擎之间的插件配置（0.41.0），只在进程内传递，包含密钥；不导入协议 / zod。
export type EngineMcpConfig = (
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | { transport: 'http'; url: string; headers?: Record<string, string> }
) & { enabled?: boolean; toolTimeoutSec?: number };

export interface EnginePluginConfig {
  skillsRoot: string;
  connectors: Array<{ name: string; config: EngineMcpConfig; enabled: boolean }>;
  skills: Array<{ name: string; path: string; enabled: boolean }>;
}
export interface EngineConnectorStatus {
  name: string;
  status?: string;
  authStatus?: string;
  tools?: Array<{ name: string; description?: string }>;
}
export interface EnginePluginSource {
  /** 每次会话 / 发送前刷新，未显式启用的外部 skill 一律禁用。 */
  read(cwd?: string): Promise<EnginePluginConfig>;
  /** 引擎的 skill / MCP 状态发生变化，Host 通知客户端重读。 */
  changed(): void;
}
