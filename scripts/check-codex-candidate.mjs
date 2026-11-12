#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const schemaRoot = 'codex-rs/app-server-protocol/schema/typescript/';
const cancellation = new AbortController();
const featureFile = 'codex-rs/features/src/lib.rs';
const layoutFiles = [
  'scripts/codex_package/layout.py',
  'scripts/codex_package/targets.py',
  'scripts/codex_package/rg',
  'codex-rs/install-context/src/lib.rs',
];
const targets = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
];

export function parseArgs(args) {
  const tag = args[0]?.startsWith('rust-v') ? args[0] : `rust-v${args[0]}`;
  if (!/^rust-v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag))
    throw new Error('版本格式：rust-v0.167.1（也接受预发布版本）');
  if (args.slice(1).some((arg) => arg !== '--diff-only') || args.length > 2)
    throw new Error('用法：node scripts/check-codex-candidate.mjs <版本> [--diff-only]');
  return { tag, diffOnly: args.includes('--diff-only') };
}

export function featureDefaults(source) {
  const features = Object.fromEntries(
    [
      ...source.matchAll(
        /key:\s*"([^"]+)"[\s\S]*?stage:\s*Stage::(\w+)[\s\S]*?default_enabled:\s*([^\n]+)/g,
      ),
    ].map(([, key, stage, value]) => [key, { stage, default: value.trim().replace(/,$/, '') }]),
  );
  if (!Object.keys(features).length)
    throw new Error('无法解析上游 FeatureSpec，请查看 features.diff');
  return features;
}

export function schemaFiles(protocol, files, read) {
  const selected = new Set();
  const missing = [];
  for (const [name] of protocol.matchAll(/(?:v2\/)?[A-Z][A-Za-z0-9]*\.ts/g)) {
    const path = files.has(name) ? name : `v2/${name}`;
    if (files.has(path)) selected.add(path);
    else missing.push(name);
  }
  // 注释引用的类型及其传递依赖都需要比较。
  for (const path of selected) {
    for (const [, from] of read(path).matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const dependency = `${posix.normalize(posix.join(posix.dirname(path), from))}.ts`;
      if (files.has(dependency)) selected.add(dependency);
    }
  }
  return { files: [...selected].sort(), missing: [...new Set(missing)].sort() };
}

export function assetDigest(asset) {
  if (!/^sha256:[0-9a-f]{64}$/.test(asset?.digest ?? ''))
    throw new Error(`Release 没有有效 SHA-256：${asset?.name ?? '缺少资产'}`);
  return asset.digest.slice(7);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }).trimEnd();
}

async function json(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    signal: AbortSignal.any([AbortSignal.timeout(30_000), cancellation.signal]),
  });
  if (!response.ok) {
    const reset = response.headers.get('x-ratelimit-reset');
    const detail =
      response.headers.get('x-ratelimit-remaining') === '0' && reset
        ? `；匿名 API 限流，重试时间 ${new Date(Number(reset) * 1000).toISOString()}`
        : '';
    throw new Error(`${response.status} ${url}${detail}`);
  }
  return response.json();
}

export async function run(
  command,
  args,
  cwd,
  env = process.env,
  logFile,
  signal = cancellation.signal,
) {
  signal.throwIfAborted();
  console.log(`$ ${command} ${args.join(' ')}`);
  const log = logFile ? createWriteStream(logFile) : undefined;
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32' && command === 'pnpm',
    detached: process.platform !== 'win32',
  });
  let stopping;
  const stop = () => {
    if (!child.pid) return;
    stopping = (async () => {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
        return;
      }
      // Codex 自成进程组，先记下整棵后代树，不能只结束 pnpm 的组。
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number));
      const ids = new Set([child.pid]);
      let previous;
      do {
        previous = ids.size;
        for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid);
      } while (previous !== ids.size);
      const kill = (pid, signal) => {
        try {
          process.kill(pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      };
      for (const pid of ids) {
        kill(-pid, 'SIGTERM');
        kill(pid, 'SIGTERM');
      }
      const deadline = Date.now() + 5000;
      for (const pid of ids) {
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === 'ESRCH') break;
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        kill(-pid, 'SIGKILL');
        kill(pid, 'SIGKILL');
      }
    })();
  };
  signal.addEventListener('abort', stop, { once: true });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      log?.write(chunk);
    });
  return new Promise((resolveRun, reject) => {
    child.on('error', (error) => {
      signal.removeEventListener('abort', stop);
      log?.end();
      reject(error);
    });
    child.on('close', async (code, terminationSignal) => {
      signal.removeEventListener('abort', stop);
      log?.end();
      try {
        await stopping;
      } catch (error) {
        reject(error);
        return;
      }
      if (signal.aborted) reject(signal.reason);
      else resolveRun({ command: [command, ...args], exitCode: code, signal: terminationSignal });
    });
  });
}

async function download(url, digest, archive, apiURL) {
  let result = await run(
    'curl',
    ['-fLsS', '--retry', '2', '--max-time', '300', url, '-o', archive],
    dirname(archive),
  );
  if (result.exitCode !== 0 && apiURL)
    result = await run(
      'curl',
      [
        '-fLsS',
        '--retry',
        '2',
        '--max-time',
        '300',
        '-H',
        'Accept: application/octet-stream',
        apiURL,
        '-o',
        archive,
      ],
      dirname(archive),
    );
  if (result.exitCode !== 0) throw new Error(`下载失败：${url}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== digest) throw new Error(`SHA-256 不符：${url}`);
  console.log(`VERIFIED ${url.split('/').at(-1)} sha256:${digest}`);
}

function findFile(directory, name) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const nested = findFile(path, name);
      if (nested) return nested;
    }
  }
}

export function validationEnv(binary, env) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('WEVIR_'))),
    WEVIR_CODEX_BIN: binary,
    WEVIR_CODEX_LEGACY_BIN: env.WEVIR_CODEX_LEGACY_BIN ?? '',
    WEVIR_TEST_API_KEY: '',
    WEVIR_TEST_PROVIDER: '',
    WEVIR_BASELINE: '1',
  };
}

async function main(args) {
  const { tag, diffOnly } = parseArgs(args);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cache = join(root, '.wevir-dev/codex-candidate', tag);
  mkdirSync(cache, { recursive: true });
  const lock = join(cache, 'running');
  mkdirSync(lock);
  const scratch = mkdtempSync(join(cache, 'tmp-'));
  const report = { tag, diffOnly, steps: [], assets: [], startedAt: new Date().toISOString() };
  const stop = () => cancellation.abort(new Error('检查已取消'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const read = (path) => readFileSync(join(root, path), 'utf8');
  try {
    for (const name of ['tests.json', 'tests.log', 'build.log', 'install.log']) {
      const path = join(cache, name);
      if (existsSync(path)) rmSync(path);
    }
    const pinned = read('packages/adapter-codex/src/paths.ts').match(
      /CODEX_VERSION = '(rust-v[^']+)'/,
    )[1];
    const [, url, , baseline] = read('docs/upstream/upstream.lock')
      .split('\n')
      .find((line) => line.startsWith('codex '))
      .trim()
      .split(/\s+/);
    report.pinned = pinned;
    const release = await json(`https://api.github.com/repos/openai/codex/releases/tags/${tag}`);
    if (release.tag_name !== tag) throw new Error('Release tag 与候选版本不同');
    writeFileSync(join(cache, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    report.release = release.html_url;
    const common = dirname(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    let source = join(common, 'upstream/codex');
    try {
      git(source, ['cat-file', '-e', `${baseline}^{commit}`]);
      git(source, ['cat-file', '-e', `${tag}^{commit}`]);
    } catch {
      source = join(cache, 'source.git');
      if (!existsSync(source)) git(cache, ['init', '--bare', source]);
      for (const ref of [baseline, `refs/tags/${tag}:refs/tags/${tag}`]) {
        const step = await run('git', ['fetch', '--depth=1', '--no-tags', url, ref], source);
        report.steps.push({ name: 'source', ...step });
        if (step.exitCode !== 0) throw new Error(`拉取上游提交失败：${ref}`);
      }
    }
    const candidate = git(source, ['rev-parse', `${tag}^{commit}`]);
    report.source = { baseline, candidate };
    const show = (sha, path) => git(source, ['show', `${sha}:${path}`]);
    const references = [baseline, candidate].map((sha) => {
      const files = new Set(
        git(source, ['ls-tree', '-r', '--name-only', sha, '--', schemaRoot])
          .split('\n')
          .map((path) => path.slice(schemaRoot.length)),
      );
      return schemaFiles(read('packages/adapter-codex/src/protocol.ts'), files, (path) =>
        show(sha, schemaRoot + path),
      );
    });
    report.missingSchemaReferences = references.map((entry, i) => ({
      sha: [baseline, candidate][i],
      missing: entry.missing,
    }));
    const schemas = [...new Set(references.flatMap((entry) => entry.files))];
    const diff = (paths, name) => {
      const text = git(source, ['diff', baseline, candidate, '--', ...paths]);
      writeFileSync(join(cache, name), `${text}\n`);
      return git(source, ['diff', '--name-only', baseline, candidate, '--', ...paths])
        .split('\n')
        .filter(Boolean);
    };
    report.schemas = {
      count: schemas.length,
      changed: diff(
        schemas.map((path) => schemaRoot + path),
        'protocol.diff',
      ),
    };
    report.experimental = diff(['codex-rs/app-server-protocol/src/protocol'], 'experimental.diff');
    diff([featureFile], 'features.diff');
    const [before, after] = [baseline, candidate].map((sha) =>
      featureDefaults(show(sha, featureFile)),
    );
    report.features = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => ({ key, before: before[key] ?? null, after: after[key] ?? null }));
    report.layout = diff(layoutFiles, 'layout.diff');
    const expected = targets.flatMap((target) =>
      [
        'codex-app-server',
        'codex-code-mode-host',
        ...(target.includes('linux') ? ['bwrap'] : []),
      ].map((name) => `${name}-${target}${target.includes('windows') ? '.exe' : ''}.tar.gz`),
    );
    report.assets = release.assets
      .filter((asset) =>
        /^(codex-(app-server|code-mode-host|exec-server)|bwrap)-.*\.tar\.gz$/.test(asset.name),
      )
      .map(({ name, size, digest }) => ({ name, size, digest }));
    report.assetIssues = expected.filter(
      (name) =>
        !release.assets.some(
          (asset) => asset.name === name && /^sha256:[0-9a-f]{64}$/.test(asset.digest ?? ''),
        ),
    );
    const platform = {
      darwin: 'apple-darwin',
      linux: 'unknown-linux-musl',
      win32: 'pc-windows-msvc',
    }[process.platform];
    const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
    const target = `${arch}-${platform}`;
    if (!targets.includes(target)) throw new Error(`不支持本机目标：${target}`);
    report.target = target;
    const exe = process.platform === 'win32' ? '.exe' : '';
    const packageDir = join(cache, 'package');
    mkdirSync(join(packageDir, 'bin'), { recursive: true });
    mkdirSync(join(packageDir, 'codex-path'), { recursive: true });
    async function install(name, url, digest, filename, destination, apiURL) {
      const archive = join(scratch, name);
      await download(url, digest, archive, apiURL);
      const unpacked = join(scratch, `unpacked-${name}`);
      mkdirSync(unpacked);
      execFileSync('tar', ['-xf', archive, '-C', unpacked]);
      const binary = findFile(unpacked, filename) ?? findFile(unpacked, filename.split('-')[0]);
      if (!binary) throw new Error(`${name} 缺少 ${filename}，检查包布局变化`);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(binary, destination);
      chmodSync(destination, 0o755);
    }
    for (const name of [
      'codex-app-server',
      'codex-code-mode-host',
      ...(process.platform === 'linux' ? ['bwrap'] : []),
    ]) {
      const asset = release.assets.find((asset) => asset.name === `${name}-${target}${exe}.tar.gz`);
      const digest = assetDigest(asset);
      await install(
        asset.name,
        asset.browser_download_url,
        digest,
        `${name}-${target}${exe}`,
        join(packageDir, name === 'bwrap' ? 'codex-resources/bwrap' : `bin/${name}${exe}`),
        asset.url,
      );
    }
    const rgManifest = show(candidate, 'scripts/codex_package/rg');
    const rg = JSON.parse(rgManifest.slice(rgManifest.indexOf('{'))).platforms[
      `${{ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform]}-${arch}`
    ];
    const rgURL = rg.providers[0].url;
    await install(
      rgURL.split('/').at(-1),
      rgURL,
      rg.digest,
      `rg${exe}`,
      join(packageDir, `codex-path/rg${exe}`),
    );
    writeFileSync(
      join(packageDir, 'codex-package.json'),
      `${JSON.stringify({ layoutVersion: 1, version: tag.slice(6), target, variant: 'codex-app-server', entrypoint: `bin/codex-app-server${exe}`, resourcesDir: 'codex-resources', pathDir: 'codex-path' }, null, 2)}\n`,
    );
    const binary = join(packageDir, `bin/codex-app-server${exe}`);
    report.binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    if (report.binaryVersion !== `codex-app-server ${tag.slice(6)}`)
      throw new Error(`二进制版本不符：${report.binaryVersion}`);
    if (!diffOnly) {
      const snapshot = join(scratch, 'validation');
      mkdirSync(snapshot);
      for (const file of git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean)) {
        if (!existsSync(join(root, file))) continue;
        mkdirSync(dirname(join(snapshot, file)), { recursive: true });
        copyFileSync(join(root, file), join(snapshot, file));
      }
      git(snapshot, ['init', '--quiet']);
      for (const file of [
        'packages/adapter-codex/src/paths.ts',
        'packages/adapter-codex/src/test-fixtures/fake-app-server.mjs',
      ]) {
        const path = join(snapshot, file);
        writeFileSync(path, readFileSync(path, 'utf8').replaceAll(pinned.slice(6), tag.slice(6)));
      }
      const env = validationEnv(binary, process.env);
      for (const [name, args] of [
        ['install', ['install', '--offline', '--frozen-lockfile']],
        ['build', ['--filter', '@wevir/host...', 'build']],
        [
          'tests',
          [
            'vitest',
            'run',
            '--project',
            'adapter-codex',
            '--project',
            'model-gateway',
            '--project',
            'host',
            '--maxWorkers=2',
            '--reporter=default',
            '--reporter=json',
            `--outputFile=${join(cache, 'tests.json')}`,
          ],
        ],
      ]) {
        const step = await run('pnpm', args, snapshot, env, join(cache, `${name}.log`));
        report.steps.push({ name, ...step });
        if (name === 'tests' && existsSync(join(cache, 'tests.json'))) {
          const tests = JSON.parse(readFileSync(join(cache, 'tests.json'), 'utf8'));
          report.tests = {
            passed: tests.numPassedTests,
            failed: tests.numFailedTests,
            skipped: tests.numPendingTests,
            todo: tests.numTodoTests,
          };
        }
        if (step.exitCode !== 0) throw new Error(`${name} 失败，见 ${name}.log`);
      }
    }
    if (report.assetIssues.length)
      throw new Error('六目标资产不完整或缺少 SHA-256，见 assetIssues');
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(cache, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(
      join(cache, 'report.md'),
      `# Codex candidate ${tag}\n\n${report.error ?? (diffOnly ? '仅比较，未运行测试。' : '检查完成；差异仍需人工评估。')}\n\n- 锁定版本：${report.pinned}\n- 协议：${report.schemas?.count ?? '—'} 个 schema，变化 ${report.schemas?.changed.length ?? '—'} 个\n- 未生成的 schema 引用：${JSON.stringify(report.missingSchemaReferences ?? [])}；实验类型查 experimental.diff\n- 实验协议 Rust 源码变化：${report.experimental?.length ?? '—'} 个文件\n- 特性默认值/阶段变化：${report.features?.length ?? '—'} 个\n- 布局变化：${report.layout?.length ?? '—'} 个文件\n- 六目标资产问题：${report.assetIssues?.length ?? '—'} 个\n- 测试：${JSON.stringify(report.tests ?? '未运行或未完成，见 steps')}\n\n详情：report.json、protocol.diff、experimental.diff、features.diff、layout.diff；执行输出：install.log、build.log、tests.log。版本断言只在临时副本中调整，工作区锁定文件不变。未使用真实模型；真实服务、桌面及其他平台仍需单独验收。\n`,
    );
    rmSync(scratch, { recursive: true });
    rmSync(lock, { recursive: true });
    console.log(
      `CHECK_RESULT ${JSON.stringify({ tag, diffOnly, binaryVersion: report.binaryVersion, schemas: report.schemas, features: report.features, layout: report.layout, assetIssues: report.assetIssues, tests: report.tests, error: report.error })}`,
    );
    console.log(`报告：${join(cache, 'report.md')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help'))
    console.log(
      '用法：node scripts/check-codex-candidate.mjs <版本> [--diff-only]\n默认在临时副本中离线安装依赖、构建并运行三个项目；真实模型开关清空。',
    );
  else
    main(process.argv.slice(2)).catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
