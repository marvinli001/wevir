import { describe, expect, it } from 'vitest';
import { plainPreviewLine } from './plain-preview.js';

describe('plainPreviewLine', () => {
  it('drops emphasis, inline code and link markup', () => {
    expect(plainPreviewLine('**Pulse status — 27 Oct** (master at `f6c1396`)')).toBe(
      'Pulse status — 27 Oct (master at f6c1396)',
    );
    expect(plainPreviewLine('See [the docs](https://example.com) and ~~old~~ *new* _notes_')).toBe(
      'See the docs and old new notes',
    );
  });

  it('keeps underscores and asterisks inside words and code', () => {
    expect(plainPreviewLine('call `wevir_process_kill` on snake_case_name, 2*3*4')).toBe(
      'call wevir_process_kill on snake_case_name, 2*3*4',
    );
  });

  it('strips block markers and skips fences, rules and table dividers', () => {
    expect(plainPreviewLine('\n## Today\n')).toBe('Today');
    expect(plainPreviewLine('> - [x] **Done**')).toBe('Done');
    expect(plainPreviewLine('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(plainPreviewLine('---\n1. First')).toBe('First');
    expect(plainPreviewLine('| service | p50 |\n|---|---|\n| api | 47 ms |')).toBe('service · p50');
  });

  it('returns an empty string when nothing is left', () => {
    expect(plainPreviewLine('\n\n---\n')).toBe('');
  });
});
