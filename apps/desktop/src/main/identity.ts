import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClientIdentity } from '@wevir/protocol';

/**
 * 桌面端在 `host.hello` 里的身份（ADR-0002 §2），存在 Host 的数据目录里，格式与 CLI 的
 * `apps/cli/src/identity.ts` 相同：
 * - `device-id`：设备级，本机的桌面与 CLI 共用（谁先用到谁创建）；
 * - `desktop-client-id`：桌面这个安装的 `clientId`，跨次运行不变，与 CLI 的 `cli-client-id` 不同。
 */
export const IDENTITY_FILES = {
  deviceId: 'device-id',
  desktopClientId: 'desktop-client-id',
} as const;

export async function loadDesktopIdentity(home: string): Promise<ClientIdentity> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const deviceId = await readOrCreate(join(home, IDENTITY_FILES.deviceId), 'dev');
  const clientId = await readOrCreate(join(home, IDENTITY_FILES.desktopClientId), 'desktop');
  return { clientKind: 'desktop', deviceId, clientId };
}

/** 读出已有的 ID；没有就以排他创建写入新的（并发创建时读别人写的那个）。 */
async function readOrCreate(path: string, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readId(path);
    if (existing !== undefined) return existing;
    const id = `${prefix}-${randomBytes(6).toString('hex')}`;
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(`${id}\n`);
      } finally {
        await file.close();
      }
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 另一个进程刚创建了它，可能还没写完：稍后重读。
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`无法读写 ${path}`);
}

async function readId(path: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const id = text.trim();
  if (id === '') return undefined;
  if (id.length > 128) throw new Error(`${path} 的内容不是合法的 ID`);
  return id;
}
