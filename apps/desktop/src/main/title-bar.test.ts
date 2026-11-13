import { describe, expect, it } from 'vitest';
import { TITLE_BAR_HEIGHT, titleBarOverlay } from './title-bar.js';

describe('titleBarOverlay', () => {
  it('底色透明，图形颜色跟深浅色', () => {
    const light = titleBarOverlay(false, 1);
    const dark = titleBarOverlay(true, 1);
    expect(light.color).toBe('#00000000');
    expect(dark.color).toBe('#00000000');
    expect(light.symbolColor).not.toBe(dark.symbolColor);
  });

  it('高跟着界面缩放比例，与顶栏一样高', () => {
    expect(titleBarOverlay(false, 1).height).toBe(TITLE_BAR_HEIGHT);
    expect(titleBarOverlay(false, 1.25).height).toBe(55);
    expect(titleBarOverlay(false, 0.8).height).toBe(35);
  });

  it('缩放比例不是有限数或超出范围时收回到合法值', () => {
    expect(titleBarOverlay(false, Number.NaN).height).toBe(TITLE_BAR_HEIGHT);
    expect(titleBarOverlay(false, 0).height).toBe(11);
    expect(titleBarOverlay(false, 100).height).toBe(220);
  });
});
