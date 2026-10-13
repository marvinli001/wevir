// 测试用的 Host（host-lifecycle.test.ts，T5.5）：用 @wevir/host 的 startHost 起一个真实的 Host（EchoAdapter，
// 每步 --step-ms 毫秒，用来在流式输出中途杀掉它），读到归属管道的 EOF 就优雅退出，同 wevir-host
// --exit-on-stdin-eof。数据目录里有 crash-on-start 文件时一启动就以退出码 1 结束，用来走“重新拉起都失败”
// 的路径。跑的是 dist/，要先 pnpm build。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createLogger, startHost } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';

const { values } = parseArgs({
  strict: false,
  options: {
    home: { type: 'string' },
    'exit-on-stdin-eof': { type: 'boolean' },
    'step-ms': { type: 'string' },
  },
});
const home = String(values.home);

if (existsSync(join(home, 'crash-on-start'))) {
  process.stderr.write('simulated startup crash\n');
  process.exit(1);
}

const host = await startHost({
  home,
  adapter: new EchoAdapter({ stepDelayMs: Number(values['step-ms'] ?? 2) }),
  engine: 'echo',
  logger: createLogger({ level: 'error' }),
  onShutdownRequest: () => void host.shutdown().then(() => process.exit(0)),
});
process.stdout.write(`${JSON.stringify({ event: 'ready', pid: process.pid, url: host.url })}\n`);
process.stdin.on('end', () => void host.shutdown().then(() => process.exit(0)));
process.stdin.resume();
