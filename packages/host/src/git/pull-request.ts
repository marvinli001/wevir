import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostError } from '../errors.js';
import { gitEnv } from '../git-diff.js';
import { redactDiagnostics } from '../secret-patterns.js';

const exec = promisify(execFile);

/** 只把当前仓库所选远端的仓库名交给 gh，不把远端内嵌的用户名、凭据带进命令或错误。 */
function githubRepository(address: string): string | undefined {
  const scp = /^(?:git@)?github\.com:(.+)$/i.exec(address);
  const url = URL.canParse(address) ? new URL(address) : undefined;
  const path =
    scp?.[1] ??
    (url?.hostname === 'github.com' && ['https:', 'ssh:'].includes(url.protocol)
      ? url.pathname.slice(1)
      : undefined);
  const repo = path?.replace(/\/$/, '').replace(/\.git$/i, '');
  return repo && /^[\w-]+\/[\w.-]+$/.test(repo) && !repo.endsWith('/..') && !repo.endsWith('/.')
    ? repo
    : undefined;
}

async function gh(cwd: string, args: string[], body?: string): Promise<string> {
  const run = exec('gh', args, {
    cwd,
    env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  run.child.stdin?.on('error', () => {});
  run.child.stdin?.end(body);
  try {
    return (await run).stdout.trim();
  } catch (error) {
    const cause = error as { code?: string; stderr?: string };
    const message =
      cause.code === 'ENOENT'
        ? 'GitHub CLI (gh) is required on the Host'
        : redactDiagnostics(cause.stderr?.trim().slice(-4096) || 'GitHub CLI request failed');
    throw new HostError('INVALID_PARAMS', message, { issues: [{ path: ['remote'], message }] });
  }
}

export async function createPullRequest(
  cwd: string,
  address: string,
  head: { branch: string; commit: string },
  input: { title: string; body?: string | undefined; base?: string | undefined },
): Promise<{ url: string }> {
  const repo = githubRepository(address);
  if (!repo) {
    const message = 'the selected remote is not a GitHub repository';
    throw new HostError('INVALID_PARAMS', message, { issues: [{ path: ['remote'], message }] });
  }
  const published = await gh(cwd, [
    'api',
    '--hostname',
    'github.com',
    `repos/${repo}/git/ref/heads/${encodeURIComponent(head.branch)}`,
    '--jq',
    '.object.sha',
  ]);
  if (published !== head.commit) {
    const message = 'push the current branch before opening its pull request';
    throw new HostError('INVALID_PARAMS', message, {
      issues: [{ path: ['expected', 'head'], message }],
    });
  }
  const url = await gh(
    cwd,
    [
      'pr',
      'create',
      '--repo',
      `github.com/${repo}`,
      '--head',
      head.branch,
      ...(input.base ? ['--base', input.base] : []),
      '--title',
      input.title,
      '--body-file',
      '-',
    ],
    input.body ?? '',
  );
  const parsed = URL.canParse(url) ? new URL(url) : undefined;
  if (
    parsed?.origin !== 'https://github.com' ||
    !/^\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(parsed.pathname)
  ) {
    throw new Error('GitHub CLI returned no pull request URL');
  }
  return { url };
}
