import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger, startHost } from '../../packages/host/dist/index.js';
import { EchoAdapter } from '../../packages/runtime-adapter/dist/echo.js';
import { hostMetrics } from './metrics.mjs';

class PerfEcho extends EchoAdapter {
  scenes = new Map();
  async send(id, input) {
    const text = input.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
    this.scenes.set(id, text);
    return super.send(id, input);
  }
  async *subscribe(id) {
    let reply;
    for await (const event of super.subscribe(id)) {
      const scene = this.scenes.get(id);
      if (scene === 'perf:tool' && event.type === 'tool.finished') {
        let output = '';
        for (let batch = 0; batch < 200; batch++) {
          output += Array.from(
            { length: 100 },
            (_, line) => `line ${batch * 100 + line + 1}: synthetic tool output\n`,
          ).join('');
          yield { type: 'tool.updated', engineSessionId: id, toolCallId: event.toolCallId, output };
          await sleep(25);
        }
        yield { ...event, output };
      } else if (scene === 'perf:reply' && event.type === 'assistant.delta') {
        if (reply !== undefined) continue;
        reply = '';
        for (let chunk = 0; chunk < 240; chunk++) {
          const text = `Measurement ${chunk + 1}: **streaming** a repeatable Markdown response.\n\n`;
          reply += text;
          yield { ...event, text };
          await sleep(40);
        }
      } else if (scene === 'perf:reply' && event.type === 'assistant.message') {
        yield { ...event, text: reply };
        reply = undefined;
      } else yield event;
    }
  }
}

// The fixture never contacts model services, account CLIs, or public endpoints.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw new Error('Offline performance fixture');
  return nativeFetch(input, init);
};
const home = process.env.WEVIR_HOME;
const logger = createLogger({ dir: join(home, 'logs'), base: { pid: process.pid } });
const metrics = hostMetrics();
const record = (label) => {
  const sample = { label, ...metrics.sample() };
  logger.info('runtime performance', sample);
  return sample;
};
const timer = setInterval(() => record('periodic'), 1000);
let host;
let stopping;
const shutdown = () => {
  stopping ??= (async () => {
    clearInterval(timer);
    metrics.close();
    await host.shutdown();
    logger.close();
    process.exit(0);
  })();
  return stopping;
};
host = await startHost({
  home,
  engine: 'echo',
  adapter: new PerfEcho(),
  logger,
  pluginUserHome: join(home, 'user'),
  userHome: join(home, 'user'),
  onShutdownRequest: shutdown,
});
process.parentPort.on('message', ({ data }) => {
  if (data.type === 'wevir-host:shutdown') void shutdown();
  if (data.type === 'perf:sample')
    process.parentPort.postMessage({ type: 'perf:sample', sample: record(data.label) });
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
record('ready');
