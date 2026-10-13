#!/usr/bin/env node
// wevir：Wevir 命令行客户端的可执行入口（T4.2）。用法见 `wevir --help`。

import { runCli } from './cli.js';

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  onInterrupt: (listener) => {
    process.on('SIGINT', listener);
    return () => process.off('SIGINT', listener);
  },
});
// 管道上的 stdout / stderr 可能是异步写的，先等写完再退出；stdin 与残留的计时器不该让进程挂着。
await Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write('', r))));
process.exit(code);
