import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';
import type { IncrementalState } from './acp-process.js';
import type { AcpEngine } from './engine.js';

/**
 * ACP 引擎在契约测试（`runAdapterContract`）里声明的能力：引擎描述的能力表，加上跟着增量旁路走的
 * `incrementalStream`。只有旁路在当前进程里报到了（`AcpProcess.incrementalState === 'active'`）才为 true；
 * 旁路关闭、没准备好或没加载时为 false：适配器只产出 ACP 的已提交消息，契约里的增量条款跳过，其余条款照跑。
 */
export function acpAdapterCapabilities(
  engine: Pick<AcpEngine, 'capabilities'>,
  incremental: IncrementalState,
): AdapterCapabilities {
  return { incrementalStream: incremental === 'active', ...engine.capabilities };
}
