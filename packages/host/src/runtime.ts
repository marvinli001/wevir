// 给客户端进程（wevir CLI、将来的桌面主进程）用的轻量入口 `@wevir/host/runtime`：数据目录的位置、
// `run/host.json` 的解析与陈旧判断、wevir-host 的退出码。只依赖 Node 内置模块，不会把存储、RPC 服务与
// 引擎适配器带进来。读取端点并连接 Host 用 `@wevir/client-sdk/node`。

export { EXIT_CODE } from './exit-code.js';
export { HOME_LAYOUT, homePath, type ResolveHomeOptions, resolveHome } from './home.js';
export { LOG_FILE } from './logger.js';
export {
  type HostRuntimeInfo,
  isProcessAlive,
  isRuntimeInfoStale,
  parseRuntimeInfo,
  RUNTIME_FILE,
} from './runtime-file.js';
