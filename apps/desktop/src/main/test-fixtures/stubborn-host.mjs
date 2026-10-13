// 测试用的 Host（host-lifecycle.test.ts）：用 @wevir/host 的 startHost 起一个真实的 Host（EchoAdapter），
// 但读到归属管道的 EOF 也不退出，用来走 HostLifecycle.stop 的升级路径。`--ignore-shutdown` 时连
// host.shutdown 也不理，只能被强制结束。参数与 wevir-host 相同的部分：--home、--exit-on-stdin-eof。
// 跑的是 dist/，要先 pnpm build。

import { parseArgs } from 'node:util';
import { createLogger, startHost } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';

const { values } = parseArgs({
  strict: false,
  options: {
    home: { type: 'string' },
    'exit-on-stdin-eof': { type: 'boolean' },
    'ignore-shutdown': { type: 'boolean' },
  },
});

const host = await startHost({
  home: String(values.home),
  adapter: new EchoAdapter(),
  engine: 'echo',
  logger: createLogger({ level: 'error' }),
  onShutdownRequest: () => {
    if (values['ignore-shutdown']) return;
    void host.shutdown().then(() => process.exit(0));
  },
});
process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, url: host.url })}\n`);
// 读 stdin，但 EOF 时什么也不做。
process.stdin.resume();
