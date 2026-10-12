// T0.3 原型 Cordis 插件：ACP 只转发已提交的 assistant/message，没有增量分片。
// 本插件监听进程内的 agent/assistant-stream，把每个 start / chunk / end frame
// 以 NDJSON 写到 WEVIR_STREAM_FD（由 Wevir 在 spawn 时额外打开的管道），不碰 stdout 上的 ACP 流量。

import { createWriteStream } from 'node:fs';

export const name = 'wevir-stream-tap';

export function apply(ctx) {
  const fd = Number(process.env.WEVIR_STREAM_FD);
  if (!Number.isInteger(fd) || fd < 3) {
    ctx.logger.warn('wevir-stream-tap: WEVIR_STREAM_FD 未设置，插件不工作');
    return;
  }
  const out = createWriteStream('', { fd, autoClose: false });
  out.on('error', (error) => ctx.logger.warn(`wevir-stream-tap: ${error}`));
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    out.write(`${JSON.stringify({ sessionId: agent.session.id, frame })}\n`);
  });
}
