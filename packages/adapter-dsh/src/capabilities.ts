import { acpAdapterCapabilities } from '@wevir/adapter-acp';
import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';
import type { StreamTapState } from './dsh-process.js';
import { DSH_ENGINE } from './engine.js';

/**
 * dsh 适配器在契约测试（`runAdapterContract`，T3.6）里声明的能力：`DSH_ENGINE` 的能力表，加上跟着增量流式旁路
 * （T3.2a，ADR-0001 §3）走的 `incrementalStream`：只有 stream-tap 插件在当前进程里报到了
 * （`DshProcess.streamTapState === 'active'`）才为 true。旁路关闭、插件装不上或没加载时为 false：
 * 适配器只产出 ACP 的已提交消息，契约里的增量条款跳过，其余条款照跑。
 */
export function dshAdapterCapabilities(streamTap: StreamTapState): AdapterCapabilities {
  return acpAdapterCapabilities(DSH_ENGINE, streamTap);
}
