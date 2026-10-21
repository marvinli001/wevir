#!/usr/bin/env node
// wevir-host：Local Agent Host 的可执行入口（T2.5，ADR-0002 §6）。用法见 `wevir-host --help`。

import { type HostCliProcess, runHostCli } from './cli.js';

const code = await runHostCli({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  on: process.on.bind(process) as HostCliProcess['on'],
  pid: process.pid,
  // 只在 Electron 的 utility process 里有（@types/node 没有这个属性）。
  parentPort: (process as { parentPort?: HostCliProcess['parentPort'] }).parentPort,
});
// 管道上的 stdout / stderr 可能是异步写的，先等写完，再退出。stdin、残留的计时器或句柄都不该让
// 进程继续挂着，所以显式 exit。
await Promise.all([process.stdout, process.stderr].map((s) => new Promise((r) => s.write('', r))));
process.exit(code);
