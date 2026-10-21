// 测试用的 Electron 主进程（host-lifecycle.test.ts）：照 utility-host.ts 的方式以 utility process 跑 wevir-host，把经过写成
// 一行行 JSON 打到 stdout，然后退出。参数经环境变量给：WEVIR_TEST_HOST_ENTRY（入口）、WEVIR_TEST_HOST_HOME（数据目录）、
// WEVIR_TEST_SHUTDOWN（请 Host 退出的消息，JSON）。
//
// 1. 拉起第一个 Host，等它的就绪行（带 pid 与 execPath 的父进程号）；
// 2. 同一数据目录再拉起一个：它应以退出码 3 结束（utility process 的退出码要传得回来）；
// 3. 经 parentPort 发退出消息，第一个 Host 应优雅退出（退出码 0）。

import { app, utilityProcess } from 'electron';

const entry = process.env.WEVIR_TEST_HOST_ENTRY;
const home = process.env.WEVIR_TEST_HOST_HOME;
const shutdown = JSON.parse(process.env.WEVIR_TEST_SHUTDOWN ?? 'null');
const report = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function fork(forwardStderr) {
  const env = { ...process.env, WEVIR_HOME: home };
  for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key];
  const child = utilityProcess.fork(entry, ['--home', home, '--adapter', 'echo'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    serviceName: 'Wevir Host',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve) => {
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += String(chunk);
      for (const line of buffered.split('\n').slice(0, -1)) {
        if (line.includes('"event":"ready"')) resolve(JSON.parse(line));
      }
      buffered = buffered.slice(buffered.lastIndexOf('\n') + 1);
    });
  });
  // 第二个 Host 的“已有 Host 在运行”是预期的，不转出来。
  if (forwardStderr) child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  else child.stderr.resume();
  return { child, exited, ready };
}

app.dock?.hide();
app.whenReady().then(async () => {
  try {
    const first = fork(true);
    const ready = await Promise.race([first.ready, first.exited.then((code) => ({ code }))]);
    report({ step: 'ready', ready, utilityPid: first.child.pid });
    const second = fork(false);
    report({ step: 'second', code: await second.exited });
    first.child.postMessage(shutdown);
    report({ step: 'shutdown', code: await first.exited });
  } catch (error) {
    report({ step: 'error', message: String(error) });
  }
  app.exit(0);
});
