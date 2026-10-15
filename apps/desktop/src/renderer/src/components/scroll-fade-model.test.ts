import { describe, expect, it } from 'vitest';
import { fadeEdges } from './scroll-fade-model';

describe('fadeEdges', () => {
  it('fades nothing when the content fits', () => {
    expect(fadeEdges(0, 300, 300)).toEqual({ top: false, bottom: false });
  });

  it('fades only the bottom at the top, only the top at the bottom', () => {
    expect(fadeEdges(0, 900, 300)).toEqual({ top: false, bottom: true });
    expect(fadeEdges(600, 900, 300)).toEqual({ top: true, bottom: false });
  });

  it('fades both ends in the middle', () => {
    expect(fadeEdges(200, 900, 300)).toEqual({ top: true, bottom: true });
  });

  it('treats sub-pixel leftovers from zoom as the edge', () => {
    expect(fadeEdges(0.5, 900, 300)).toEqual({ top: false, bottom: true });
    expect(fadeEdges(599.4, 900, 300)).toEqual({ top: true, bottom: false });
  });
});
