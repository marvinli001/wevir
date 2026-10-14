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
  // ACP 引擎没有子会话（ADR-0005 决策 6.1：dsh、Gemini CLI 的子 agent 不产生更新），也不能插话（ACP 没有往进行中的
  // prompt 里追加输入的办法，R11：适配器不实现 steer，Host 一律排队）。
  return {
    incrementalStream: incremental === 'active',
    subagents: false,
    steer: false,
    ...engine.capabilities,
  };
}
