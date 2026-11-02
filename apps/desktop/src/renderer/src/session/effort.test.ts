import { describe, expect, it } from 'vitest';
import { carryEffort } from './effort';

describe('换模型沿用思考力度', () => {
  it('新模型有这一档就照用', () => {
    expect(carryEffort('max', ['low', 'medium', 'high', 'xhigh', 'max'])).toBe('max');
  });

  it('没有这一档取最接近的，一样近取低的', () => {
    expect(carryEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(carryEffort('minimal', ['low', 'high'])).toBe('low');
    expect(carryEffort('medium', ['low', 'high'])).toBe('low');
  });

  it('默认档、没有档位的模型与不认识的档位给 undefined', () => {
    expect(carryEffort(undefined, ['low', 'high'])).toBeUndefined();
    expect(carryEffort('high', [])).toBeUndefined();
    expect(carryEffort('high', undefined)).toBeUndefined();
    expect(carryEffort('turbo', ['low', 'high'])).toBeUndefined();
  });
});
