/**
 * `wevir-host` 的退出码。单独成文件，供拉起 Host 的客户端进程（wevir CLI、桌面主进程）经
 * `@wevir/host/runtime` 引用，不必加载整个 Host。
 */
export const EXIT_CODE = {
  ok: 0,
  /** 启动失败、运行中的致命错误、优雅退出超时被强制结束。 */
  failure: 1,
  usage: 2,
  /** 该数据目录已有活着的 Host（读 `run/host.json` 附着即可）。 */
  alreadyRunning: 3,
} as const;
