import { WorkerPoolManager } from '@pierre/diffs/worker';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';

const fixtures = [
  [
    'typescript',
    'sample.ts',
    'export function value(input: number): string { return "value " + (input + 1); }\n',
  ],
  ['json', 'sample.json', '{"name":"sample","values":[1,2,3],"enabled":true}\n'],
  ['python', 'sample.py', 'def value(input):\n    return {"value": input + 1, "enabled": True}\n'],
  ['bash', 'sample.sh', 'for file in *.ts; do printf "%s\\n" "$file"; done\n'],
].map(([language, name, line]) => ({
  language,
  name,
  contents: line.repeat(Math.ceil(19_000 / line.length)).slice(0, 19_000),
}));
let pool;

function summarize(samples) {
  samples.sort((a, b) => a - b);
  return { p50Ms: samples[Math.floor(samples.length / 2)], maxMs: samples.at(-1) };
}

export async function measureHljs() {
  const start = performance.now();
  const { default: hljs } = await import('highlight.js/lib/common');
  const importMs = performance.now() - start;
  const rows = [];
  for (const fixture of fixtures) {
    const run = () =>
      hljs.highlight(fixture.contents, { language: fixture.language, ignoreIllegals: true }).value;
    const firstAt = performance.now();
    const html = run();
    const firstMs = performance.now() - firstAt;
    const samples = [];
    for (let index = 0; index < 10; index++) {
      const at = performance.now();
      run();
      samples.push(performance.now() - at);
    }
    rows.push({
      language: fixture.language,
      chars: fixture.contents.length,
      htmlChars: html.length,
      firstMs,
      ...summarize(samples),
    });
  }
  return { importMs, rows };
}

export async function startWorker() {
  const at = performance.now();
  pool = new WorkerPoolManager(
    {
      workerFactory: () => new DiffsWorker(),
      poolSize: 1,
      initialPoolSize: 1,
      totalASTLRUCacheSize: 240,
    },
    {
      theme: 'pierre-dark',
      preferredHighlighter: 'shiki-wasm',
      tokenizeMaxLineLength: 1_000,
      useTokenTransformer: true,
    },
  );
  await pool.initialize();
  return { ms: performance.now() - at, stats: pool.getStats() };
}

export async function measureWorker() {
  const rows = [];
  let sequence = 0;
  for (const fixture of fixtures) {
    const run = async () => {
      const file = {
        name: fixture.name,
        contents: fixture.contents,
        cacheKey: `highlight-bench-${++sequence}`,
      };
      await pool.primeFileHighlightCache(file);
      const result = pool.getFileResultCache(file);
      if (!result?.result.code.length) throw new Error('Worker did not produce a highlighted AST');
      pool.evictFileFromCache(file.cacheKey);
    };
    const firstAt = performance.now();
    await run();
    const firstMs = performance.now() - firstAt;
    const samples = [];
    for (let index = 0; index < 10; index++) {
      const at = performance.now();
      await run();
      samples.push(performance.now() - at);
    }
    rows.push({
      language: fixture.language,
      chars: fixture.contents.length,
      firstMs,
      ...summarize(samples),
    });
  }
  return { rows, stats: pool.getStats() };
}

export function stopWorker() {
  pool?.terminate();
  pool = undefined;
}
