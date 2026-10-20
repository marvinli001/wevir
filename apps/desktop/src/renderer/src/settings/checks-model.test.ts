import type { CheckCandidate, CheckDefinition } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  candidateSaved,
  draftOf,
  draftOfCandidate,
  draftValid,
  inputOf,
  parsePaths,
  sourceText,
} from './checks-model';

const check: CheckDefinition = {
  id: 'chk_00000000000000000000000001',
  name: 'test',
  command: 'pnpm run test',
  cwd: 'packages/core',
  timeoutMs: 300_000,
  kind: 'test',
  trigger: 'after_turn',
  paths: ['src/', 'test/**'],
  source: { kind: 'package_script', file: 'package.json', script: 'test', scriptHash: 'sha256:aa' },
  revision: 3,
  approvedAt: '2026-10-20T00:00:00.000Z',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
};

describe('草稿', () => {
  it('检查 → 草稿 → 输入：保留字段，脚本来源去掉散列（保存即重新认可）', () => {
    const draft = draftOf(check);
    expect(draft).toMatchObject({ paths: 'src/, test/**', timeout: '5' });
    expect(inputOf(draft)).toEqual({
      id: check.id,
      name: 'test',
      command: 'pnpm run test',
      cwd: 'packages/core',
      kind: 'test',
      trigger: 'after_turn',
      timeoutMs: 300_000,
      paths: ['src/', 'test/**'],
      source: { kind: 'package_script', file: 'package.json', script: 'test' },
    });
  });

  it('新检查默认手动、10 分钟；名称、命令为空或超时不合法时不能保存', () => {
    const draft = draftOf();
    expect(draft).toMatchObject({ trigger: 'manual', timeout: '10', source: { kind: 'user' } });
    expect(draftValid(draft)).toBe(false);
    const filled = { ...draft, name: 'lint', command: 'pnpm lint' };
    expect(draftValid(filled)).toBe(true);
    expect(draftValid({ ...filled, timeout: '0' })).toBe(false);
    expect(draftValid({ ...filled, timeout: 'abc' })).toBe(false);
    expect(draftValid({ ...filled, timeout: '61' })).toBe(false);
    expect(inputOf({ ...filled, expectOutput: '  ' })).not.toHaveProperty('expectOutput');
  });

  it('候选 → 草稿：命令与来源照搬，说明文件的来源不带行号', () => {
    const candidate: CheckCandidate = {
      name: 'pnpm test',
      command: 'pnpm test',
      cwd: '',
      kind: 'test',
      source: { kind: 'instructions', file: 'AGENTS.md', line: 12 },
    };
    expect(draftOfCandidate(candidate)).toMatchObject({
      command: 'pnpm test',
      source: { kind: 'instructions', file: 'AGENTS.md' },
    });
    expect(candidateSaved(candidate, [check])).toBe(false);
    expect(
      candidateSaved({ ...candidate, command: 'pnpm run test', cwd: 'packages/core' }, [check]),
    ).toBe(true);
  });

  it('路径按逗号与换行分开；来源文本', () => {
    expect(parsePaths(' src/ ,\ntest/** ,, ')).toEqual(['src/', 'test/**']);
    expect(sourceText(check)).toBe('package.json · test');
    expect(sourceText({ source: { kind: 'user' } })).toBeUndefined();
  });
});
