import { readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

export async function buildHighlightBenchmark() {
  const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url));
  const require = createRequire(join(desktop, 'package.json'));
  const assets = join(desktop, 'out', 'renderer', 'assets');
  const bundle = [];
  for (const name of await readdir(assets)) {
    if (!name.startsWith('common-') || !name.endsWith('.js')) continue;
    const contents = await readFile(join(assets, name));
    if (!contents.includes('registerLanguage')) continue;
    bundle.push({ name, bytes: contents.length, gzipBytes: gzipSync(contents).length });
  }
  if (bundle.length !== 1) throw new Error('Expected one production highlight.js common chunk');
  const { build } = await import(pathToFileURL(require.resolve('vite')).href);
  const outDir = join(assets, 'perf-highlighting');
  await build({
    configFile: false,
    root: desktop,
    base: './',
    publicDir: false,
    logLevel: 'error',
    resolve: {
      alias: [
        {
          find: /^@pierre\/diffs\/worker\/worker\.js(?=\?|$)/,
          replacement: join(desktop, 'node_modules/@pierre/diffs/dist/worker/worker.js'),
        },
        {
          find: /^@pierre\/diffs\/worker$/,
          replacement: join(desktop, 'node_modules/@pierre/diffs/dist/worker/index.js'),
        },
        {
          find: 'highlight.js/lib/common',
          replacement: require.resolve('highlight.js/lib/common'),
        },
      ],
    },
    worker: { format: 'es' },
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      lib: {
        entry: fileURLToPath(new URL('./highlight-entry.mjs', import.meta.url)),
        formats: ['es'],
        fileName: () => 'bench.js',
      },
    },
  });
  return {
    bundle,
    url: 'wevir://app/assets/perf-highlighting/bench.js',
    cleanup: () => rm(outDir, { recursive: true, force: true }),
  };
}
