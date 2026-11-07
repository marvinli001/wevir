// pnpm build && node scripts/perf/run.mjs [--idle-seconds 300] [--library-mib 976] [--out <new directory>]
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { cpus, freemem, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { webSocketTransport } from '../../packages/client-sdk/dist/index.js';
import { connectLocalHost } from '../../packages/client-sdk/dist/node.js';
import { connectCdp } from './cdp.mjs';
import { DELETE_SESSION, PROVIDER, seedLibrary, WORKSPACE } from './fixture.mjs';
import { installCommitProbe } from './metrics.mjs';
import { processTree, readProcesses } from './process-tree.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'idle-seconds': { type: 'string', default: '300' },
    'library-mib': { type: 'string', default: '976' },
    'software-gpu': { type: 'boolean', default: false },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'pnpm build && node scripts/perf/run.mjs [--idle-seconds 300] [--library-mib 976] [--out <new directory>]',
  );
  process.exit(0);
}
const idleSeconds = Number(values['idle-seconds']);
const libraryMiB = Number(values['library-mib']);
if (
  !Number.isFinite(idleSeconds) ||
  idleSeconds < 0 ||
  !Number.isFinite(libraryMiB) ||
  libraryMiB <= 0
)
  throw new Error('Invalid idle duration or library size');
const root = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const electron = require('electron');
const out = values.out
  ? resolve(values.out)
  : join(root, '.wevir-dev', 'perf', new Date().toISOString().replaceAll(/[:.]/g, '-'));
await mkdir(out, { recursive: true, mode: 0o700 });
const scratch = await mkdtemp(join(out, 'fixture-'));
const home = join(scratch, 'home');
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
await exec('git', ['init', '-q', workspace]);
await exec(
  'git',
  [
    '-c',
    'user.name=Performance Fixture',
    '-c',
    'user.email=perf@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'Create performance fixture',
  ],
  { cwd: workspace },
);
const report = {
  status: 'incomplete',
  measuredAt: new Date().toISOString(),
  sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
  machine: {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    totalMemory: totalmem(),
    freeMemoryAtStart: freemem(),
    runnerNode: process.version,
  },
  config: {
    idleSeconds,
    libraryMiB,
    softwareGpu: values['software-gpu'],
    toolLines: 20_000,
    toolUpdates: 200,
    replyChunks: 240,
    replyDelayMs: 40,
    eventLoopResolutionMs: 10,
  },
  startups: [],
  samples: [],
  scenarios: {},
};
let desktop;
let cdp;
let client;

async function until(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    if (desktop?.exitCode !== null && desktop?.exitCode !== undefined)
      throw new Error(`Electron exited: ${desktop.exitCode}`);
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function launch(label) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  const env = { ...process.env, WEVIR_HOME: home };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'WEVIR_NODE', 'NODE_OPTIONS'])
    delete env[key];
  desktop = spawn(
    electron,
    [
      fileURLToPath(new URL('./desktop.mjs', import.meta.url)),
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      ...(values['software-gpu'] ? ['--disable-gpu'] : []),
    ],
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let startup;
  const samples = new Map();
  let diagnostic = '';
  desktop.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + String(chunk)).slice(-12_000);
  });
  desktop.on('error', (error) => {
    diagnostic += error.message;
  });
  createInterface({ input: desktop.stdout }).on('line', (line) => {
    if (line.startsWith('[wevir-desktop] info startup timing '))
      startup = JSON.parse(line.slice(line.indexOf('{')));
    if (line.startsWith('{"event":"perf"')) {
      const sample = JSON.parse(line);
      samples.set(sample.host.label, sample);
    }
  });
  desktop.perfSamples = samples;
  try {
    await until(() => startup, 'startup timing');
    report.startups.push({ label, ...startup });
    const targets = await until(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
      if (!response?.ok) return false;
      return (await response.json()).find(
        (target) => target.type === 'page' && target.url.startsWith('wevir://app'),
      );
    }, 'renderer CDP');
    cdp = await connectCdp(targets.webSocketDebuggerUrl);
    await until(
      () => cdp.evaluate("Boolean(document.querySelector('#root')?.children.length)"),
      'first screen',
    );
    client = await connectLocalHost({
      home,
      identity: { clientKind: 'cli', clientId: 'runtime-perf', deviceId: 'runtime-perf' },
      transport: webSocketTransport(WebSocket),
      timeouts: { requestMs: 120_000 },
    });
    report.runtime = await cdp.evaluate('window.navigator.userAgent');
    console.log(`${label}: window=${startup.windowMs} ms, host=${startup.hostMs} ms`);
  } catch (error) {
    throw new Error(`${error.message}\n${diagnostic}`, { cause: error });
  }
}

async function stop() {
  client?.close();
  client = undefined;
  cdp?.close();
  cdp = undefined;
  if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null) return;
  const exited = once(desktop, 'exit');
  desktop.stdin.write(`${JSON.stringify({ type: 'quit' })}\n`);
  const forced = setTimeout(() => desktop.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(forced);
}

async function sample(label) {
  desktop.stdin.write(`${JSON.stringify({ type: 'sample', label })}\n`);
  const value = await until(() => desktop.perfSamples.get(label), `Host sample ${label}`);
  const tree = processTree(await readProcesses(), value);
  if (!tree.processes.some((row) => row.category === 'host'))
    throw new Error('Host missing from process tree');
  const effects = await cdp.evaluate(`(() => {
    const count = (selector, property, enabled) => [...document.querySelectorAll(selector)].filter(node => enabled(getComputedStyle(node)[property])).length;
    return {
      lowGpu: document.documentElement.hasAttribute('data-low-gpu'),
      blurredComposers: count('[data-composer-box]', 'backdropFilter', value => value !== 'none'),
      scrollMasks: count('.scroll-fade', 'maskImage', value => value !== 'none'),
      shimmers: count('.shimmer', 'animationName', value => value !== 'none'),
      beamAnimations: document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.target?.closest('[data-beam-preset]')).length,
    };
  })()`);
  const result = { label, ...value.host, tree, effects, database: await databaseSize() };
  report.samples.push(result);
  return result;
}

async function databaseSize() {
  const sizes = await Promise.all(
    ['wevir.db', 'wevir.db-wal'].map(async (name) => {
      try {
        return (await stat(join(home, name))).size;
      } catch (error) {
        if (error.code === 'ENOENT') return 0;
        throw error;
      }
    }),
  );
  return { main: sizes[0], wal: sizes[1] };
}

async function createSession() {
  return (await client.request('session.create', { workspaceId: WORKSPACE, providerId: PROVIDER }))
    .session;
}

async function turn(session, text) {
  const subscription = client.subscribe(session.id, { sinceSeq: session.lastSeq });
  const startedAt = Date.now();
  let events = 0;
  const done = (async () => {
    for await (const item of subscription) {
      if (item.type !== 'event') continue;
      events++;
      if (item.event.type === 'turn.finished') {
        if (item.event.payload.outcome !== 'completed')
          throw new Error(`Echo turn failed: ${item.event.payload.outcome}`);
        return;
      }
    }
    throw new Error('Turn subscription ended without turn.finished');
  })();
  const timeout = setTimeout(() => subscription.close(), 120_000);
  try {
    await client.request('session.send', {
      sessionId: session.id,
      content: [{ type: 'text', text }],
    });
    await done;
    return { startedAt, finishedAt: Date.now(), durationMs: Date.now() - startedAt, events };
  } finally {
    clearTimeout(timeout);
    subscription.close();
  }
}

async function streamingTurn(session, text) {
  let finished = false;
  const running = turn(session, text);
  void running.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  let second = 0;
  while (!finished) {
    await Promise.race([running, sleep(1000)]);
    if (!finished) await sample(`${text}-${++second}s`);
  }
  return running;
}

try {
  await seedLibrary(home, workspace, 0);
  await launch('cold-empty');
  await stop();
  await launch('second-empty');
  await stop();
  console.log(`Seeding ${libraryMiB} MiB of synthetic event payloads`);
  report.library = await seedLibrary(home, workspace, libraryMiB);
  report.library.database = await databaseSize();
  await launch('loaded-library');
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installCommitProbe.toString()})()`,
  });
  await cdp.send('Page.reload');
  await until(
    () =>
      cdp.evaluate(
        "Boolean(globalThis.__wevirPerf && document.querySelector('#root')?.children.length)",
      ),
    'commit probe',
  );
  await sample('loaded');
  const sessions = await Promise.all(Array.from({ length: 10 }, () => createSession()));
  await Promise.all(
    sessions.map((session, index) => turn(session, `Idle measurement ${index + 1}`)),
  );
  await sample('ten-sessions');
  console.log(`Ten Echo sessions complete; idling ${idleSeconds} seconds`);
  for (let elapsed = 0; elapsed < idleSeconds; elapsed += 30) {
    await sleep(Math.min(30, idleSeconds - elapsed) * 1000);
    await sample(`idle-${Math.min(elapsed + 30, idleSeconds)}s`);
    console.log(`Idle: ${Math.min(elapsed + 30, idleSeconds)}/${idleSeconds} s`);
  }
  const tool = await createSession();
  await cdp.evaluate(
    `location.hash = ${JSON.stringify(`#/workspace/${WORKSPACE}/session/${tool.id}`)}`,
  );
  desktop.stdin.write('{"type":"foreground"}\n');
  await sleep(1000);
  report.scenarios.tool = await streamingTurn(tool, 'perf:tool');
  await sample('tool-complete');
  const reply = await createSession();
  await cdp.evaluate(
    `location.hash = ${JSON.stringify(`#/workspace/${WORKSPACE}/session/${reply.id}`)}`,
  );
  await sleep(1000);
  await cdp.evaluate('globalThis.__wevirPerf.start()');
  report.scenarios.reply = await streamingTurn(reply, 'perf:reply');
  report.scenarios.reply.react = await cdp.evaluate('globalThis.__wevirPerf.stop()');
  if (
    !report.scenarios.reply.react.commits ||
    report.scenarios.reply.react.visibility !== 'visible'
  )
    throw new Error('React commit measurement did not run in a visible renderer');
  await sample('reply-complete');
  const theme = await cdp.evaluate('document.documentElement.dataset.theme');
  await cdp.evaluate("document.documentElement.dataset.theme = 'dark'");
  const dark = await sample('dark-effects');
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  const reduced = await sample('reduced-transparency');
  if (reduced.effects.scrollMasks || reduced.effects.blurredComposers)
    throw new Error('Reduced transparency effects were not disabled');
  if (
    values['software-gpu'] &&
    (!dark.effects.lowGpu || dark.effects.blurredComposers || dark.effects.scrollMasks)
  )
    throw new Error('Software GPU effects were not disabled');
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await sample('before-delete');
  await sleep(50);
  const startedAt = Date.now();
  await client.request('session.delete', { sessionId: DELETE_SESSION });
  report.scenarios.deletion = {
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt,
  };
  // Let monitorEventLoopDelay observe the timer that was delayed by synchronous deletion.
  await sleep(50);
  await sample('after-delete');
  report.status = 'complete';
} finally {
  await stop();
  const log = await readFile(join(home, 'logs', 'host.log'), 'utf8').catch(() => '');
  report.hostSamples = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.msg === 'runtime performance');
  await writeFile(join(out, 'baseline.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await rm(scratch, { recursive: true, force: true });
}
console.log(`Baseline: ${join(out, 'baseline.json')}`);
