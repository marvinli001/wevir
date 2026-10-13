// 假 dsh：DshProcess 单元测试用。按 ACP 的 NDJSON 帧回应 initialize，行为由 FAKE_DSH_MODE 决定；
// 把收到的 argv、cwd、环境和 initialize 参数写到 <cwd>/fake-dsh.json（cwd 就是 DSH_HOME）。
//
// FAKE_DSH_MODE：
//   normal          读到 stdin EOF 即退出（真实 dsh 的行为）
//   ignore-eof      不理会 stdin EOF，SIGTERM 照常退出
//   ignore-sigterm  不理会 stdin EOF 与 SIGTERM，只能 SIGKILL
//   no-initialize   不回应 initialize
//   wrong-protocol  initialize 回应协议版本 99
//   exit-on-start   往 stderr 写一行后以退出码 7 退出
//   crash-after-init  回应 initialize 50 ms 后以退出码 3 退出（每次启动都这样）
//   crash-once      同上，但只在第一次启动时（以 cwd 里的标记文件区分）
//   ask-permission  回应 initialize 后发一条 session/update 和一个 session/request_permission
// FAKE_DSH_GRANDCHILD=1：再拉起一个不理会 SIGTERM 的子进程（留在同一进程组里）。
//
// stream-tap（T3.2a）：
//   `plugin --profile acp add link:<目录>` 模拟 dsh plugin：在 profiles/acp 写 package.json 并把
//   node_modules/@wevir/dsh-stream-tap 链到该目录，每次调用往 <cwd>/plugin-calls.log 追加一行；
//   目录里有 fake-install-fails 文件时往 stderr 写一行后以退出码 1 退出。
//   设了 WEVIR_STREAM_FD 时模拟插件往 fd 3 写：FAKE_DSH_TAP 为 frames（默认）时写 ready、一个分两次写
//   的文本增量、一行畸形数据、一个推理增量和 end 帧；为 silent 时什么都不写（插件没加载）。

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.argv[2] === 'plugin') {
  const spec = process.argv.at(-1);
  const dir = spec.slice('link:'.length);
  appendFileSync('plugin-calls.log', `${process.argv.slice(2).join(' ')}\n`);
  if (existsSync(join(dir, 'fake-install-fails'))) {
    process.stderr.write('fake dsh: pnpm failed\n');
    process.exit(1);
  }
  const profile = join('profiles', 'acp');
  const scope = join(profile, 'node_modules', '@wevir');
  mkdirSync(scope, { recursive: true });
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ dependencies: { '@wevir/dsh-stream-tap': spec } }),
  );
  symlinkSync(dir, join(scope, 'dsh-stream-tap'), 'junction');
  process.exit(0);
}

const mode = process.env.FAKE_DSH_MODE ?? 'normal';
const record = { argv: process.argv.slice(2), cwd: process.cwd(), env: { ...process.env } };
const save = () => writeFileSync('fake-dsh.json', JSON.stringify(record));
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const crash = () =>
  setTimeout(() => {
    process.stderr.write('fake dsh: crashed\n');
    process.exit(3);
  }, 50);

save();
if (mode === 'exit-on-start') {
  process.stderr.write('fake dsh: cannot start\n');
  process.exit(7);
}
if (process.env.WEVIR_STREAM_FD !== undefined && process.env.FAKE_DSH_TAP !== 'silent') {
  const tap = createWriteStream('', { fd: Number(process.env.WEVIR_STREAM_FD) });
  const frame = (frame) =>
    JSON.stringify({
      type: 'frame',
      sessionId: 'fake-session',
      frame: { attemptId: 'a:1', ...frame },
    });
  const delta = frame({
    type: 'chunk',
    index: 1,
    chunk: { type: 'text-delta', index: 1, text: '你好' },
  });
  tap.write(`{"type":"ready"}\n${delta.slice(0, 40)}`);
  setTimeout(() => {
    tap.write(`${delta.slice(40)}\nnot json\n`);
    tap.write(
      `${frame({ type: 'chunk', index: 2, chunk: { type: 'reasoning-delta', index: 0, text: '想' } })}\n` +
        `${frame({ type: 'end', index: 3, outcome: { kind: 'committed' } })}\n`,
    );
  }, 20);
}
if (process.env.FAKE_DSH_GRANDCHILD === '1') {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: 'ignore' },
  );
  record.grandchild = child.pid;
  save();
}
if (mode === 'ignore-eof' || mode === 'ignore-sigterm') setInterval(() => {}, 1000);
if (mode === 'ignore-sigterm') process.on('SIGTERM', () => {});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    record.initialize = message.params;
    save();
    if (mode === 'no-initialize') return;
    send({
      id: message.id,
      result: {
        protocolVersion: mode === 'wrong-protocol' ? 99 : 1,
        agentCapabilities: {},
        agentInfo: { name: 'fake-dsh', version: '0.0.0' },
      },
    });
    if (mode === 'crash-after-init') crash();
    if (mode === 'crash-once' && !existsSync('crashed-once')) {
      writeFileSync('crashed-once', '');
      crash();
    }
    if (mode === 'ask-permission') {
      send({
        method: 'session/update',
        params: {
          sessionId: 'fake-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
        },
      });
      send({
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'fake-session',
          toolCall: { toolCallId: 'call-1' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
    }
  } else if (message.id === 'permission-1') {
    record.permissionResponse = message.result ?? message.error;
    save();
  }
});
lines.on('close', () => {
  record.stdinClosed = true;
  save();
  if (mode !== 'ignore-eof' && mode !== 'ignore-sigterm') process.exit(0);
});
