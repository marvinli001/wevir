import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const exec = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 16 * 1024 * 1024, timeout: 30_000, windowsHide: true };

export function parsePs(text) {
  return text
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) throw new Error(`Invalid ps row: ${line}`);
      return { pid: +match[1], ppid: +match[2], rss: +match[3] * 1024, name: match[4] };
    });
}

export function parseCim(text) {
  const rows = JSON.parse(text.replace(/^\uFEFF/, '').trim());
  return (Array.isArray(rows) ? rows : [rows]).filter(Boolean).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    rss: Number(row.WorkingSetSize),
    name: row.Name,
    command: row.CommandLine ?? '',
  }));
}

export async function readProcesses() {
  if (process.platform === 'win32') {
    const { stdout } = await exec(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      EXEC_OPTIONS,
    );
    return parseCim(stdout);
  }
  const [{ stdout }, { stdout: commands }] = await Promise.all([
    exec('ps', ['-A', '-o', 'pid,ppid,rss,comm'], EXEC_OPTIONS),
    exec('ps', ['-A', '-ww', '-o', 'pid=,args='], EXEC_OPTIONS),
  ]);
  const args = new Map(
    commands
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return [+match[1], match[2]];
      }),
  );
  return parsePs(stdout).map((row) => ({ ...row, command: args.get(row.pid) ?? '' }));
}

export function processTree(rows, { desktopPid, hostPid, rendererPids = [] }) {
  const ids = new Set([desktopPid, hostPid].filter(Boolean));
  let count;
  do {
    count = ids.size;
    for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
  } while (ids.size !== count);
  const processes = rows
    .filter((row) => ids.has(row.pid))
    .map((row) => {
      const name = basename(row.name.replaceAll('\\', '/'));
      const command = `${name} ${row.command ?? ''}`;
      let category = 'other';
      if (row.pid === desktopPid) category = 'desktop';
      else if (row.pid === hostPid) category = 'host';
      else if (rendererPids.includes(row.pid) || /--type=renderer\b/.test(command))
        category = 'renderer';
      else if (/wevir[-_](history|web|suggest[-_]tasks|app[-_]tools).*\.m?js\b/i.test(command))
        category = 'mcp';
      else if (
        /codex-app-server|\b(claude|opencode|grok|codebuddy|devin|copilot|kiro-cli|agy_acp_server|localharness_external)(\.exe)?\b/i.test(
          command,
        )
      )
        category = 'engine';
      else if (
        /language-server|tsc\b.*--lsp|tsgo\b.*--lsp|pyright|gopls|rust-analyzer|clangd|sourcekit-lsp/i.test(
          command,
        )
      )
        category = 'lsp';
      else if (/^(?:-)?(?:ba|z|fi|da)?sh$|^(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(name))
        category = 'terminal';
      // Arguments can contain credentials. Keep them only in memory for classification.
      return { pid: row.pid, ppid: row.ppid, name, rss: row.rss, category };
    });
  const totals = Object.fromEntries(
    ['desktop', 'renderer', 'host', 'engine', 'mcp', 'lsp', 'terminal', 'other'].map((category) => [
      category,
      { count: 0, rss: 0 },
    ]),
  );
  for (const row of processes) {
    totals[row.category].count++;
    totals[row.category].rss += row.rss;
  }
  return {
    processes,
    totals,
    count: processes.length,
    rss: processes.reduce((sum, row) => sum + row.rss, 0),
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: { pid: { type: 'string' }, 'host-pid': { type: 'string' } },
  });
  const desktopPid = Number(values.pid);
  const hostPid = values['host-pid'] ? Number(values['host-pid']) : undefined;
  if (
    !Number.isInteger(desktopPid) ||
    desktopPid <= 0 ||
    (hostPid !== undefined && (!Number.isInteger(hostPid) || hostPid <= 0))
  )
    throw new Error(
      'Usage: node scripts/perf/process-tree.mjs --pid <desktop PID> [--host-pid <Host PID>]',
    );
  const tree = processTree(await readProcesses(), { desktopPid, hostPid });
  if (!tree.processes.some((row) => row.pid === desktopPid))
    throw new Error('Desktop PID is not running');
  console.log(JSON.stringify(tree, null, 2));
}
