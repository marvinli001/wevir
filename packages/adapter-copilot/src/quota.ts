import { spawn } from 'node:child_process';
import { trackProcessGroup } from '@wevir/runtime-adapter';
import { type CopilotExecutable, needsShell } from './launch.js';
import { record } from './models.js';

/** account.getQuota 是 SDK 的 RPC，不是 ACP 扩展；只读快照，不创建模型会话。 */
export function readCopilotQuota(
  executable: CopilotExecutable,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(executable.path, ['--headless', '--stdio', '--no-auto-update'], {
      cwd: directory,
      env: executable.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: needsShell(executable.path),
    });
    trackProcessGroup(child, { kind: 'engine', name: 'copilot quota' });
    let done = false;
    const finish = (snapshots?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      child.stdin.destroy();
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        child.kill('SIGKILL');
      }
      resolve(snapshots);
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 5000);
    signal.addEventListener('abort', abort, { once: true });
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish();
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const length = /^Content-Length:\s*(\d+)$/im.exec(buffer.subarray(0, headerEnd).toString());
        if (length === null || Number(length[1]) > 1024 * 1024) return finish();
        const end = headerEnd + 4 + Number(length[1]);
        if (buffer.length < end) return;
        try {
          const response = record(JSON.parse(buffer.subarray(headerEnd + 4, end).toString()));
          buffer = buffer.subarray(end);
          if (response?.id === 1) return finish(record(response.result)?.quotaSnapshots);
        } catch {
          return finish();
        }
      }
    });
    child.stderr.resume();
    child.stdout.on('error', abort);
    child.on('error', abort);
    child.on('close', abort);
    child.stdin.on('error', abort);
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'account.getQuota',
      params: {},
    });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
  });
}
