import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const { app, BrowserWindow, utilityProcess } = require('electron');
const fork = utilityProcess.fork.bind(utilityProcess);
const output = (value) => console.log(JSON.stringify({ event: 'perf', ...value }));
let host;
utilityProcess.fork = (entry, args, options) => {
  const isHost = options?.serviceName === 'Wevir Host';
  const child = fork(
    isHost ? fileURLToPath(new URL('./host.mjs', import.meta.url)) : entry,
    args,
    options,
  );
  if (isHost) {
    host = child;
    child.on('message', (message) => {
      if (message.type === 'perf:sample')
        output({
          type: 'sample',
          host: message.sample,
          desktopPid: process.pid,
          hostPid: host.pid,
          rendererPids: BrowserWindow.getAllWindows().map((window) =>
            window.webContents.getOSProcessId(),
          ),
        });
    });
  }
  return child;
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.type === 'sample') host.postMessage({ type: 'perf:sample', label: request.label });
  if (request.type === 'quit') app.quit();
  if (request.type === 'foreground') {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.setAlwaysOnTop(true);
    window.focus();
  }
});
await import('../../apps/desktop/out/main/index.js');
