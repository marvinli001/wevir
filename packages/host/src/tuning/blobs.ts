// 档案的文本（0.85.0）：`<数据目录>/tuning/blobs/<sha256>`，按内容散列去重，供两个版本之间看文本 diff。只增不改；没有版本引用、
// 又放了一天以上的由 `prune` 删掉（当前档案的文本还没有版本引用，留一天给对比用）。

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HASH = /^[0-9a-f]{64}$/;

export class ProfileBlobStore {
  readonly dir: string;
  /** 已知存在的散列：采集时判断要不要再读文件，避免每次都查磁盘。 */
  readonly #known = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  has(hash: string): boolean {
    if (this.#known.has(hash)) return true;
    if (!HASH.test(hash) || !existsSync(join(this.dir, hash))) return false;
    this.#known.add(hash);
    return true;
  }

  async write(texts: ReadonlyMap<string, string>): Promise<void> {
    if (texts.size === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    for (const [hash, text] of texts) {
      if (!HASH.test(hash) || this.has(hash)) continue;
      const path = join(this.dir, hash);
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, path);
      this.#known.add(hash);
    }
  }

  async read(hash: string): Promise<string | undefined> {
    if (!HASH.test(hash)) return undefined;
    return readFile(join(this.dir, hash), 'utf8').catch(() => undefined);
  }

  /** 删掉不在 `referenced` 里、修改时间早于 `before` 的文本与残留的临时文件。返回删了几个。 */
  async prune(referenced: ReadonlySet<string>, before: number): Promise<number> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      if (referenced.has(name)) continue;
      const path = join(this.dir, name);
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.mtimeMs >= before) continue;
      await rm(path, { force: true });
      this.#known.delete(name);
      removed += 1;
    }
    return removed;
  }
}
