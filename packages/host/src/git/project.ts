import { mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HostError } from '../errors.js';
import { runGit } from '../git-diff.js';
import { redactDiagnostics } from '../secret-patterns.js';

function invalid(field: string, message: string) {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path: [field], message }] });
}

function cloneAddress(address: string): string {
  if (/^\w[\w.-]*@\w[\w.-]*:[^\s\p{Cc}]+$/u.test(address)) return address;
  const url = URL.canParse(address) ? new URL(address) : undefined;
  if (
    !url ||
    !['https:', 'ssh:'].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.startsWith('-') ||
    url.password ||
    (url.protocol === 'ssh:' && url.username && !/^\w[\w.-]*$/.test(url.username)) ||
    (url.protocol === 'https:' && url.username) ||
    url.search ||
    url.hash ||
    url.pathname.length <= 1 ||
    /\s/.test(address)
  ) {
    throw invalid(
      'repositoryUrl',
      'use an HTTPS or SSH Git repository address without embedded credentials',
    );
  }
  return url.href;
}

export async function createProjectDirectory(
  parent: string,
  name: string,
  repositoryUrl?: string,
): Promise<string> {
  // 目录名在 Host 的平台上必须是单个可移植的路径段。
  if (
    name === '' ||
    /[\\/<>:"|?*\p{Cc}]/u.test(name) ||
    /[ .]$/.test(name) ||
    /^(?:\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw invalid('name', 'choose a valid directory name');
  }
  const address = repositoryUrl === undefined ? undefined : cloneAddress(repositoryUrl);
  const dir = join(parent, name);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw invalid(
      'name',
      code === 'EEXIST'
        ? 'the destination already exists'
        : `cannot create the directory (${code})`,
    );
  }
  if (address !== undefined) {
    try {
      await runGit(parent, ['clone', '--no-recurse-submodules', '--', address, dir], {
        timeoutMs: 600_000,
        processGroup: true,
        env: { GIT_ALLOW_PROTOCOL: 'https:ssh' },
      });
    } catch (error) {
      // git 清理它留下的克隆内容；用户加了别的文件时保留。
      await rmdir(dir).catch(() => {});
      const message =
        error instanceof Error &&
        'stderr' in error &&
        typeof error.stderr === 'string' &&
        error.stderr
          ? error.stderr
          : 'git clone failed';
      throw invalid('repositoryUrl', redactDiagnostics(message));
    }
  }
  return dir;
}
