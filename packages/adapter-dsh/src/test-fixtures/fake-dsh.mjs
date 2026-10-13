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

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

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
if (process.env.WEVIR_STREAM_FD !== undefined) {
  createWriteStream('', { fd: Number(process.env.WEVIR_STREAM_FD) }).write('{"tap":1}\n');
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
