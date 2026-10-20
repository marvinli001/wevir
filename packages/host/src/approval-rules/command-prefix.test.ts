import { describe, expect, it } from 'vitest';
import {
  formatPrefix,
  matchCommandPrefixes,
  proposePrefix,
  proposePrefixesForCommand,
  splitShellCommand,
} from './command-prefix.js';

describe('splitShellCommand', () => {
  it('splits plain commands joined by && || ; |', () => {
    expect(splitShellCommand('git status && git diff --stat; ls -la | head -n 5 || true')).toEqual([
      ['git', 'status'],
      ['git', 'diff', '--stat'],
      ['ls', '-la'],
      ['head', '-n', '5'],
      ['true'],
    ]);
  });

  it('reads quoted words literally', () => {
    expect(splitShellCommand(`git commit -m "fix: a \\"b\\"" --author='A B'`)).toEqual([
      ['git', 'commit', '-m', 'fix: a "b"', '--author=A B'],
    ]);
  });

  it('unwraps one shell -lc layer', () => {
    expect(splitShellCommand("/bin/zsh -lc 'git status && pnpm test'")).toEqual([
      ['git', 'status'],
      ['pnpm', 'test'],
    ]);
    expect(splitShellCommand(`bash -c "ls"`)).toEqual([['ls']]);
  });

  it('rejects anything beyond literal words', () => {
    for (const command of [
      'echo $HOME',
      'echo "$HOME"',
      'echo `id`',
      'echo $(id)',
      'git status > out.txt',
      'cat < in',
      'ls *',
      '(cd x && ls)',
      '{ ls; }',
      'sleep 1 &',
      'GIT_DIR=/x git status',
      'ls ~',
      "echo 'unterminated",
      'git status &&',
      '&& git status',
      'ls |& cat',
      '# comment',
      '',
    ]) {
      expect(splitShellCommand(command), command).toBeNull();
    }
  });

  it('allows trailing separators and blank lines', () => {
    expect(splitShellCommand('git status;\n\nls\n')).toEqual([['git', 'status'], ['ls']]);
  });
});

describe('matchCommandPrefixes', () => {
  const prefixes = [['git', 'status'], ['ls']];

  it('matches when every command starts with some prefix', () => {
    expect(matchCommandPrefixes('git status --short', prefixes)).toEqual([0]);
    expect(matchCommandPrefixes("/bin/zsh -lc 'git status && ls -la'", prefixes)).toEqual([0, 1]);
  });

  it('does not match when any command is not covered', () => {
    expect(matchCommandPrefixes('git status; rm -rf /', prefixes)).toBeNull();
    expect(matchCommandPrefixes('git statusx', prefixes)).toBeNull();
    expect(matchCommandPrefixes('git', prefixes)).toBeNull();
    expect(matchCommandPrefixes('git status $(rm -rf /)', prefixes)).toBeNull();
  });
});

describe('proposePrefix', () => {
  it('stops at the subcommand for tools that have them', () => {
    expect(proposePrefix(['git', 'status', '--short'])).toEqual(['git', 'status']);
    expect(proposePrefix(['gh', 'pr', 'list'])).toEqual(['gh', 'pr']);
    expect(proposePrefix(['npm', 'run', 'test', '--', '-u'])).toEqual(['npm', 'run', 'test']);
    expect(proposePrefix(['pnpm', 'test'])).toEqual(['pnpm', 'test']);
  });

  it('takes the whole command for other programs', () => {
    expect(proposePrefix(['touch', '/x/approval.txt'])).toEqual(['touch', '/x/approval.txt']);
  });

  it('does not propose for interpreters, wrappers, destructive commands or bare tools', () => {
    expect(proposePrefix(['git', '-C', 'x', 'status'])).toBeNull();
    expect(proposePrefix(['npm'])).toBeNull();
    expect(proposePrefix(['npm', 'run'])).toBeNull();
    expect(proposePrefix(['python3'])).toBeNull();
    expect(proposePrefix(['python3', '-c', 'print(1)'])).toBeNull();
    expect(proposePrefix(['awk', '{ system("id") }'])).toBeNull();
    expect(proposePrefix(['find', '.', '-delete'])).toBeNull();
    expect(proposePrefix(['sudo', 'ls'])).toBeNull();
    expect(proposePrefix(['/usr/bin/env', 'ls'])).toBeNull();
    expect(proposePrefix(['rm', 'build'])).toBeNull();
    expect(proposePrefix(['make'])).toBeNull();
  });
});

describe('proposePrefixesForCommand', () => {
  it('proposes one prefix per command not already allowed', () => {
    expect(proposePrefixesForCommand("bash -lc 'git status && git status -s | head'", [])).toEqual([
      ['git', 'status'],
      ['head'],
    ]);
    expect(proposePrefixesForCommand('git status && head x', [['head']])).toEqual([
      ['git', 'status'],
    ]);
  });

  it('proposes nothing when a command cannot be proposed or all are covered', () => {
    expect(proposePrefixesForCommand('git status && rm -rf build')).toBeNull();
    expect(proposePrefixesForCommand('git status', [['git', 'status']])).toBeNull();
    expect(proposePrefixesForCommand('echo $X')).toBeNull();
  });
});

describe('formatPrefix', () => {
  it('quotes words with spaces or quotes', () => {
    expect(formatPrefix(['git', 'status'])).toBe('git status');
    expect(formatPrefix(['echo', "it's ok"])).toBe(`echo 'it'\\''s ok'`);
  });
});
