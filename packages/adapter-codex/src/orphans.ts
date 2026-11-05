/**
 * Linux 上停止回合时 Codex 漏掉的命令进程。
 *
 * Linux 上命令跑在 `codex-linux-sandbox` → `bwrap` → 内层 `codex-linux-sandbox`（新会话、新 PID 命名空间的 1 号进程）→
 * shell 里。`thread/backgroundTerminals/terminate` 只对外层沙箱所在的进程组发 SIGKILL：外层沙箱和 bwrap 死了，内层沙箱连同
 * 命令被过继出去接着跑完（rust-v0.165.0，macOS 与 Windows 上没有这个问题）。适配器在结束命令之前记下 app-server 的进程树，
 * 结束之后把这棵树里被过继出去、还活着的进程连同它们的子进程一起 SIGKILL。
 */
import { readdirSync, readFileSync } from 'node:fs';

export interface ProcEntry {
  pid: number;
  ppid: number;
  pgid: number;
  /** 进程启动时刻（`/proc/<pid>/stat` 第 22 项），pid 被复用时用来认出不是同一个进程。 */
  start: string;
}

/** 当前活着的进程（不含僵尸进程）。 */
export type ReadProcesses = () => Map<number, ProcEntry>;

export const readLinuxProcesses: ReadProcesses = () => {
  const table = new Map<number, ProcEntry>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    // 第 2 项是括号里的进程名，可能含空格和括号，从最后一个右括号之后开始数：rest[0] 是第 3 项。
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (rest[0] === 'Z' || rest[0] === 'X') continue;
    const pid = Number(name);
    table.set(pid, {
      pid,
      ppid: Number(rest[1]),
      pgid: Number(rest[2]),
      start: rest[19] ?? '',
    });
  }
  return table;
};

/** `root` 的全部后代进程（不含 `root`）。 */
export function descendants(table: Map<number, ProcEntry>, root: number): Map<number, ProcEntry> {
  const children = new Map<number, ProcEntry[]>();
  for (const entry of table.values()) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const found = new Map<number, ProcEntry>();
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid)) continue;
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return found;
}

export interface KillOrphansOptions {
  read?: ReadProcesses;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * `before` 是结束命令之前 `root` 的后代。等到这些进程里有一个退出，把其中还活着、却已经不在 `root` 之下的进程（被过继出去的）
 * 连同它们此刻的子进程 SIGKILL；进程组组长连整个进程组一起结束。`timeoutMs` 内没有进程退出就什么都不做。返回结束了的 pid。
 */
export async function killOrphans(
  root: number,
  before: Map<number, ProcEntry>,
  options: KillOrphansOptions = {},
): Promise<number[]> {
  const read = options.read ?? readLinuxProcesses;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const deadline = Date.now() + (options.timeoutMs ?? 1_000);
  const intervalMs = options.intervalMs ?? 50;
  for (;;) {
    const table = read();
    const alive = (entry: ProcEntry) => table.get(entry.pid)?.start === entry.start;
    const under = descendants(table, root);
    const orphans = [...before.values()].filter((entry) => alive(entry) && !under.has(entry.pid));
    if (orphans.length > 0) {
      const doomed = new Map<number, ProcEntry>();
      for (const orphan of orphans) {
        doomed.set(orphan.pid, orphan);
        for (const [pid, entry] of descendants(table, orphan.pid)) doomed.set(pid, entry);
      }
      for (const entry of doomed.values()) {
        for (const target of entry.pgid === entry.pid ? [-entry.pid, entry.pid] : [entry.pid]) {
          try {
            kill(target, 'SIGKILL');
          } catch {
            // 已经退出了。
          }
        }
      }
      return [...doomed.keys()];
    }
    if ([...before.values()].some((entry) => !alive(entry))) return [];
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
