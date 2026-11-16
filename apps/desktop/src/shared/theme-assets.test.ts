import { describe, expect, it } from 'vitest';
import { isThemeAssetUrl, isThemeSceneUrl } from './theme-assets.js';

describe('Host theme asset addresses', () => {
  const url = 'http://127.0.0.1:1234/files/token/backdrop.html?v=revision&theme-scene=1';
  it('recognizes only single-file Host grants and scene markers', () => {
    expect(isThemeAssetUrl(url, 'backdrop.html', 'revision')).toBe(true);
    expect(isThemeSceneUrl(url)).toBe(true);
    expect(isThemeSceneUrl(url.replace('&theme-scene=1', ''))).toBe(false);
    expect(isThemeSceneUrl(url.replace('backdrop.html', 'poster.png'))).toBe(false);
    for (const bad of [
      url.replace('127.0.0.1', 'example.com'),
      url.replace('http:', 'https:'),
      url.replace('/files/', '/page/'),
      url.replace('/backdrop.html', '/nested/backdrop.html'),
      url.replace('127.0.0.1', 'user@127.0.0.1'),
      `${url}&redirect=elsewhere`,
      'data:text/html,test',
    ])
      expect(isThemeAssetUrl(bad)).toBe(false);
    expect(isThemeAssetUrl(url, 'poster.png')).toBe(false);
    expect(isThemeAssetUrl(url, 'backdrop.html', 'old')).toBe(false);
  });
});
