// Wevir 的增量流式旁路插件（T3.2a，ADR-0001 §3）。由 dsh 在自己的进程里加载，不在 Host 里运行。
//
// ACP 只转发已提交的 assistant/message，没有增量分片。本插件监听 dsh 进程内的 agent/assistant-stream，
// 把每个 start / chunk / end 帧连同会话 ID 以 NDJSON 写到 WEVIR_STREAM_FD 指定的 fd（Host spawn 时
// 额外打开的管道，见 src/stream-tap.ts）。stdout 是 ACP 的协议流，这里一个字节都不写。
//
// 约束：只用 Cordis 传进来的 ctx 与 Node 内置模块，不 import @deepseek-ai/*（引擎边界，AGENTS.md）；
// 照 T0.3 原型（spikes/dsh-acp/stream-tap）重写，不引用 spikes/。函数插件只导出 name 与 apply，
// 不要默认导出（dsh 的 Loader 遇到默认导出会丢掉具名导出）。
//
// 每行一条记录：
//   {"type":"ready"}                                        apply 时写一次，表示插件已加载
//   {"type":"frame","sessionId":"<dsh 会话 ID>","frame":{…}} agent/assistant-stream 的帧，原样转发

import { createWriteStream } from 'node:fs';

export const name = 'wevir-stream-tap';

export function apply(ctx) {
  const raw = process.env.WEVIR_STREAM_FD;
  const fd = Number(raw);
  if (raw === undefined || !Number.isInteger(fd) || fd < 3) {
    ctx.logger.warn(`wevir-stream-tap: WEVIR_STREAM_FD 无效（${raw}），插件不工作`);
    return;
  }

  let broken = false;
  const out = createWriteStream('', { fd, autoClose: false });
  out.on('error', (error) => {
    // Host 关了管道（EPIPE）或 fd 没有打开（EBADF）：此后不再写，dsh 照常运行。
    broken = true;
    ctx.logger.warn(`wevir-stream-tap: 写 fd ${fd} 失败，停止转发：${error}`);
  });
  const write = (record) => {
    if (!broken) out.write(`${JSON.stringify(record)}\n`);
  };

  write({ type: 'ready' });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    // emit 事件的监听器抛错会冒到 dsh 的 agent loop 里；旁路只是增强，任何异常都吞掉。
    try {
      write({ type: 'frame', sessionId: agent.session.id, frame });
    } catch (error) {
      ctx.logger.warn(`wevir-stream-tap: 转发帧失败：${error}`);
    }
  });
}
