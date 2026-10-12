import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 密钥存储（ADR-0003 决策 3）。数据库只存 `secretRef`，密钥本身只在这里。接口是异步的：后续迁移到
 * 系统钥匙串时只换实现，`secretRef` 与调用方都不变。
 *
 * 实现不得把密钥写进日志、错误信息或事件。
 */
export interface SecretStore {
  get(secretRef: string): Promise<string | undefined>;
  set(secretRef: string, secret: string): Promise<void>;
  /** 删除；原本不存在时返回 false。 */
  delete(secretRef: string): Promise<boolean>;
}

export const SECRETS_FILE = 'secrets.json';

interface SecretsFile {
  version: 1;
  secrets: Record<string, string>;
}

/**
 * 骨架阶段的实现：`<dataDir>/secrets.json`，权限 0600。
 *
 * 写入：先以 0600 排他创建同目录下的临时文件，写完、fsync 后 rename 覆盖正式文件。任何时刻都没有
 * 宽权限的中间文件，正式文件也不会只写了一半；旧文件即使权限更宽，也会被新的 0600 文件替换。
 *
 * Windows：`chmod` 与创建时的 mode 只能改只读位，0600 不生效。骨架依赖数据目录
 * `%APPDATA%\Wevir` 的按用户 ACL（默认只有本用户与管理员可读）保护这个文件；T6.1 的安全说明
 * 要如实写明，直到迁移到系统钥匙串（Windows 凭据管理器）。
 *
 * 同一实例内的操作串行执行，避免并发 set 互相覆盖。不支持多个进程同时写（一个数据目录只有一个 Host）。
 */
export class FileSecretStore implements SecretStore {
  readonly path: string;
  readonly #dir: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dir = dataDir;
    this.path = join(dataDir, SECRETS_FILE);
  }

  get(secretRef: string): Promise<string | undefined> {
    checkRef(secretRef);
    return this.#serial(async () => (await this.#load()).get(secretRef));
  }

  set(secretRef: string, secret: string): Promise<void> {
    checkRef(secretRef);
    if (typeof secret !== 'string') throw new TypeError('secret 必须是字符串');
    return this.#serial(async () => {
      const secrets = await this.#load();
      secrets.set(secretRef, secret);
      await this.#save(secrets);
    });
  }

  delete(secretRef: string): Promise<boolean> {
    checkRef(secretRef);
    return this.#serial(async () => {
      const secrets = await this.#load();
      if (!secrets.delete(secretRef)) return false;
      await this.#save(secrets);
      return true;
    });
  }

  #serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op, op);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #load(): Promise<Map<string, string>> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // 不附带 JSON.parse 的原始错误：V8 的报错信息会引用文件内容片段，可能包含密钥。
      throw new Error(`${this.path} 不是合法的 JSON，未做任何修改`);
    }
    const file = parsed as Partial<SecretsFile> | null;
    const secrets = file?.secrets;
    if (
      file?.version !== 1 ||
      typeof secrets !== 'object' ||
      secrets === null ||
      Array.isArray(secrets) ||
      !Object.values(secrets).every((value) => typeof value === 'string')
    ) {
      throw new Error(`${this.path} 的格式无法识别，未做任何修改`);
    }
    return new Map(Object.entries(secrets));
  }

  async #save(secrets: Map<string, string>): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const file: SecretsFile = { version: 1, secrets: Object.fromEntries(secrets) };
    const tmp = join(this.#dir, `.${SECRETS_FILE}.${randomBytes(6).toString('hex')}.tmp`);
    let handle: FileHandle | undefined;
    try {
      // wx：排他创建；mode 在创建时生效。umask 只会去掉权限位，再 chmod 一次确保正好是 0600。
      handle = await open(tmp, 'wx', 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tmp, this.path);
    } catch (err) {
      await handle?.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}

function checkRef(secretRef: string): void {
  if (typeof secretRef !== 'string' || secretRef.length === 0) {
    throw new TypeError('secretRef 必须是非空字符串');
  }
}
