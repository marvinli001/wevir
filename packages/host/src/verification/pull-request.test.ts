import type { VerificationEvidence } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { verificationMarkdown } from './pull-request.js';

const evidence = {
  status: 'partial',
  commit: '0123456789ab',
  checks: [
    {
      checkId: 'chk_tests',
      name: 'Unit tests',
      kind: 'test',
      status: 'passed',
      tests: { passed: 8, failed: 0, skipped: 1 },
      summary:
        'sk-secret-shaped-fixture-0123456789 /Users/local-user/private.ts developer.local original output',
      outputAvailable: true,
    },
    {
      checkId: 'chk_lint',
      name: 'Lint',
      kind: 'lint',
      status: 'stale',
      outputAvailable: false,
    },
    {
      checkId: 'chk_types',
      name: 'Typecheck',
      kind: 'typecheck',
      status: 'not_run',
      outputAvailable: false,
    },
  ],
} satisfies VerificationEvidence;

describe('PR verification Markdown', () => {
  it('includes the commit and each result without raw output or machine-local data', () => {
    const markdown = verificationMarkdown(evidence);
    expect(markdown).toEqual(
      [
        '### Checks · `0123456789ab`',
        '',
        '- Unit tests · Passed (8 passed, 0 failed, 1 skipped)',
        '- Lint · Does not match this commit',
        '- Typecheck · Not run',
      ].join('\n'),
    );
    expect(markdown).not.toMatch(
      /\/Users\/|sk-secret-shaped|local-user|developer\.local|original output/,
    );
  });

  it('uses the interface locale and omits the section when unconfigured', () => {
    expect(verificationMarkdown(evidence, 'zh-TW')).toContain('### 檢查 · `0123456789ab`');
    expect(verificationMarkdown(evidence, 'de')).toContain('Lint · Gilt für einen anderen Commit');
    expect(
      verificationMarkdown({ commit: '0123456789ab', status: 'unconfigured', checks: [] }),
    ).toBe('');
  });
});
