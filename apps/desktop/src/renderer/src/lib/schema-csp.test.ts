import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import './schema-csp';

it('validates renderer object schemas without probing dynamic code under CSP', () => {
  const compile = vi.fn(() => {
    throw new EvalError('CSP');
  });
  vi.stubGlobal('Function', new Proxy(Function, { construct: compile }));
  try {
    const schema = z.object({ count: z.number() });
    expect(schema.safeParse({ count: 1 }).success).toBe(true);
    expect(schema.safeParse({ count: '1' }).success).toBe(false);
    expect(compile).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
