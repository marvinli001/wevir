import { describe, expect, it } from 'vitest';
import { formatVariables, parseVariables } from './variables-text';

const previous = [
  { name: 'STRIPE_SECRET_KEY', preview: 'sk_test_51...gGGa' },
  { name: 'NODE_ENV', preview: '••••••••' },
];

describe('formatVariables', () => {
  it('一行一个 名字=打码值；没有变量时是空文本', () => {
    expect(formatVariables(previous)).toBe(
      'STRIPE_SECRET_KEY=sk_test_51...gGGa\nNODE_ENV=••••••••',
    );
    expect(formatVariables(undefined)).toBe('');
  });
});

describe('parseVariables', () => {
  it('没改的行只回名字，改了的与新加的带值，顺序照写', () => {
    const text = 'STRIPE_SECRET_KEY=sk_test_51...gGGa\nNODE_ENV=production\nAPI_BASE=http://x';
    expect(parseVariables(text, previous)).toEqual({
      ok: true,
      variables: [
        { name: 'STRIPE_SECRET_KEY' },
        { name: 'NODE_ENV', value: 'production' },
        { name: 'API_BASE', value: 'http://x' },
      ],
    });
  });

  it('按 .env 的写法：空行、注释、export、引号、值里的等号与空值', () => {
    const text = [
      '# comment',
      '',
      'export A = 1 ',
      'B="line\\nnext \\"q\\""',
      "C='raw \\n'",
      'D=a=b',
      'E=',
    ].join('\r\n');
    expect(parseVariables(text, undefined)).toEqual({
      ok: true,
      variables: [
        { name: 'A', value: '1' },
        { name: 'B', value: 'line\nnext "q"' },
        { name: 'C', value: 'raw \\n' },
        { name: 'D', value: 'a=b' },
        { name: 'E', value: '' },
      ],
    });
  });

  it('格式不对的行报行号；名字重复、用了保留前缀时报名字', () => {
    expect(parseVariables('A=1\nnot a line', undefined)).toEqual({
      ok: false,
      error: { kind: 'line', line: 2 },
    });
    expect(parseVariables('1A=x', undefined)).toMatchObject({ error: { kind: 'line', line: 1 } });
    expect(parseVariables('A=1\nA=2', undefined)).toEqual({
      ok: false,
      error: { kind: 'duplicate', name: 'A' },
    });
    expect(parseVariables('wevir_token=1', undefined)).toEqual({
      ok: false,
      error: { kind: 'reserved', name: 'wevir_token' },
    });
  });
});
