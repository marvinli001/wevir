import { describe, expect, it } from 'vitest';
import { fastParam, isFast, supportsFast } from './fast-mode';

const provider = {
  models: [
    { id: 'sol', supportsFast: true },
    { id: 'luna', supportsFast: true, fastByDefault: true },
    { id: 'plain', fastByDefault: true },
  ],
};
const choice = (modelId: string, fast?: boolean) => ({
  providerId: 'chatgpt',
  modelId,
  ...(fast !== undefined && { fast }),
});

describe('快速模式（0.148.0）', () => {
  it('supportsFast：只认 Host 标了 supportsFast 的模型', () => {
    expect(supportsFast(provider, 'sol')).toBe(true);
    expect(supportsFast(provider, 'plain')).toBe(false);
    expect(supportsFast(provider, 'missing')).toBe(false);
    expect(supportsFast(undefined, 'sol')).toBe(false);
  });

  it('isFast：选过的按选的，没选过的取模型默认；不支持的模型一律不是', () => {
    expect(isFast(provider, choice('sol'))).toBe(false);
    expect(isFast(provider, choice('sol', true))).toBe(true);
    expect(isFast(provider, choice('luna'))).toBe(true);
    expect(isFast(provider, choice('luna', false))).toBe(false);
    expect(isFast(provider, choice('plain', true))).toBe(false);
  });

  it('fastParam：选过且模型支持时才带', () => {
    expect(fastParam(provider, choice('sol', false))).toEqual({ fast: false });
    expect(fastParam(provider, choice('luna'))).toEqual({});
    expect(fastParam(provider, choice('plain', true))).toEqual({});
  });
});
