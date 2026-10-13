import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';
import type { StreamTapState } from './dsh-process.js';

/**
 * dsh 适配器在契约测试（`runAdapterContract`，T3.6）里声明的能力。
 *
 * `incrementalStream` 跟着增量流式旁路走（T3.2a，ADR-0001 §3）：只有 stream-tap 插件在当前进程里报到了
 * （`DshProcess.streamTapState === 'active'`）才为 true。旁路关闭、插件装不上或没加载时为 false：
 * 适配器只产出 ACP 的已提交消息，契约里的增量条款跳过，其余条款照跑。
 *
 * 其余几项是 ACP 路径本身的能力，与旁路无关（T0.3 实测）：工具调用（场景 A）、审批（B / C / D）、
 * close 之后 resume（§3.2、场景 H）、单进程多会话并发（§10）。
 */
export function dshAdapterCapabilities(streamTap: StreamTapState): AdapterCapabilities {
  return {
    incrementalStream: streamTap === 'active',
    toolCalls: true,
    approvals: true,
    resume: true,
    concurrentSessions: true,
  };
}
