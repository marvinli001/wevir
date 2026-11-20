import { open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Project instructions are loaded root first. Without a project marker Codex only reads cwd. */
export async function projectInstructionFiles(
  cwd: string,
  engine: 'codex' | 'opencode',
): Promise<Array<{ name: string; text: string }>> {
  const dirs = [cwd];
  for (let dir = cwd; !(await stat(join(dir, '.git')).catch(() => undefined)); ) {
    const parent = dirname(dir);
    if (parent === dir) {
      dirs.splice(1);
      break;
    }
    dirs.push(parent);
    dir = parent;
  }
  let remaining = engine === 'codex' ? 32768 : Infinity;
  const files = [];
  for (const dir of dirs.reverse()) {
    if (!remaining) break;
    for (const basename of engine === 'codex'
      ? ['AGENTS.override.md', 'AGENTS.md']
      : ['AGENTS.md']) {
      const name = join(dir, basename);
      const info = await stat(name).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (!info.size) break;
      const file = await open(name, 'r').catch(() => undefined);
      if (!file) break;
      try {
        const length = Math.min(remaining, info.size);
        const buffer = Buffer.alloc(length);
        const result = await file.read(buffer, 0, length, 0);
        const text = buffer.toString('utf8', 0, result.bytesRead);
        if (text.trim()) {
          files.push({ name, text });
          remaining -= result.bytesRead;
        }
      } catch {
        /* File removed or made unreadable after discovery. */
      } finally {
        await file.close();
      }
      break;
    }
  }
  return files;
}
