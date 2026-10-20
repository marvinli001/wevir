import { describe, expect, it } from 'vitest';
import { atLeast, parseVersionOutput, satisfiesNpmRange, satisfiesPep440 } from './versions.js';

describe('parseVersionOutput', () => {
  it('取各种 --version 输出里的版本号', () => {
    expect(parseVersionOutput('v24.21.0')).toBe('24.21.0');
    expect(parseVersionOutput('12.6.0')).toBe('12.6.0');
    expect(parseVersionOutput('Python 3.12.4')).toBe('3.12.4');
    expect(parseVersionOutput('go version go1.22.3 darwin/arm64')).toBe('1.22.3');
    expect(parseVersionOutput('rustc 1.85.0 (4d91de4e4 2025-02-17)')).toBe('1.85.0');
    expect(parseVersionOutput('Apple clang version 17.0.0 (clang-1700.0.13.3)')).toBe('17.0.0');
    expect(parseVersionOutput('GNU Make 3.81')).toBe('3.81');
    expect(parseVersionOutput('no digits')).toBeUndefined();
  });
});

describe('satisfiesNpmRange', () => {
  it.each([
    ['24.21.0', '>=24.15', true],
    ['24.10.0', '>=24.15', false],
    ['12.6.0', '^12.6.0', true],
    ['13.0.0', '^12.6.0', false],
    ['0.3.4', '^0.3.1', true],
    ['0.4.0', '^0.3.1', false],
    ['3.1.9', '~3.1', true],
    ['3.2.0', '~3.1', false],
    ['24.3.0', '24.x', true],
    ['24.3.0', '24', true],
    ['25.0.0', '24', false],
    ['24.15.1', '24.15.1', true],
    ['24.15.2', '24.15.1', false],
    ['1.3.0', '1.2 - 1.4', true],
    ['1.5.0', '1.2 - 1.4', false],
    ['18.0.0', '^16 || ^18', true],
    ['20.0.0', '>=18 <20', false],
    ['19.9.9', '>= 18 < 20', true],
    ['26.0.0', '*', true],
  ])('%s 满足 %s：%s', (version, range, expected) => {
    expect(satisfiesNpmRange(version, range)).toBe(expected);
  });

  it('认不出的范围是 undefined', () => {
    expect(satisfiesNpmRange('24.0.0', 'lts/*')).toBeUndefined();
    expect(satisfiesNpmRange('x', '>=1')).toBeUndefined();
  });
});

describe('satisfiesPep440', () => {
  it.each([
    ['3.12.4', '>=3.11', true],
    ['3.10.0', '>=3.11', false],
    ['3.12.4', '>=3.11,<4', true],
    ['3.12.4', '~=3.12', true],
    ['4.0.0', '~=3.12', false],
    ['3.12.4', '==3.12.*', true],
    ['3.13.0', '==3.12.*', false],
    ['3.12.4', '!=3.12.4', false],
  ])('%s 满足 %s：%s', (version, specifier, expected) => {
    expect(satisfiesPep440(version, specifier)).toBe(expected);
  });

  it('认不出的要求是 undefined', () => {
    expect(satisfiesPep440('3.12.0', '>=3.11; python_version')).toBeUndefined();
  });
});

describe('atLeast', () => {
  it('go.mod 的最低版本', () => {
    expect(atLeast('1.22.3', '1.22')).toBe(true);
    expect(atLeast('1.21.9', '1.22')).toBe(false);
    expect(atLeast('?', '1.22')).toBeUndefined();
  });
});
