import { describe, expect, it } from 'vitest';
import { base64Bytes, fitWithin, PHOTO_MAX_EDGE } from './photo-size';

describe('photo size', () => {
  it('scales the long edge down to the limit and keeps the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: PHOTO_MAX_EDGE, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: PHOTO_MAX_EDGE });
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800 });
    expect(fitWithin(10000, 1)).toEqual({ width: PHOTO_MAX_EDGE, height: 1 });
  });

  it('counts decoded base64 bytes', () => {
    expect(base64Bytes('YQ==')).toBe(1);
    expect(base64Bytes('YWI=')).toBe(2);
    expect(base64Bytes('YWJj')).toBe(3);
  });
});
