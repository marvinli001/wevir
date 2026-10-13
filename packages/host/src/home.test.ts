import { describe, expect, it } from 'vitest';
import { homePath, resolveHome } from './home.js';

describe('resolveHome', () => {
  const base = { homedir: '/Users/u', cwd: '/repo', platform: 'darwin' as const };

  it('WEVIR_HOME 优先于 --home，--home 优先于平台默认', () => {
    expect(resolveHome({ ...base, env: { WEVIR_HOME: '/data/a' }, home: '/data/b' })).toBe(
      '/data/a',
    );
    expect(resolveHome({ ...base, env: {}, home: '/data/b' })).toBe('/data/b');
    expect(resolveHome({ ...base, env: {} })).toBe('/Users/u/Library/Application Support/Wevir');
  });

  it('相对路径按 cwd 解析；空字符串当作没给', () => {
    expect(resolveHome({ ...base, env: {}, home: './.wevir-dev' })).toBe('/repo/.wevir-dev');
    expect(resolveHome({ ...base, env: { WEVIR_HOME: 'rel' } })).toBe('/repo/rel');
    expect(resolveHome({ ...base, env: { WEVIR_HOME: '' }, home: '/data/b' })).toBe('/data/b');
    expect(resolveHome({ ...base, env: {}, home: '' })).toBe(
      '/Users/u/Library/Application Support/Wevir',
    );
  });

  it('Windows：%APPDATA%\\Wevir，没有 APPDATA 时退回 ~\\AppData\\Roaming', () => {
    const win = { homedir: 'C:\\Users\\u', cwd: 'C:\\repo', platform: 'win32' as const };
    expect(resolveHome({ ...win, env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } })).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Wevir',
    );
    expect(resolveHome({ ...win, env: {} })).toBe('C:\\Users\\u\\AppData\\Roaming\\Wevir');
    expect(resolveHome({ ...win, env: {}, home: '.wevir-dev' })).toBe('C:\\repo\\.wevir-dev');
  });

  it('Linux：$XDG_DATA_HOME/wevir，未设或不是绝对路径时退回 ~/.local/share/wevir', () => {
    const linux = { homedir: '/home/u', cwd: '/repo', platform: 'linux' as const };
    expect(resolveHome({ ...linux, env: { XDG_DATA_HOME: '/xdg' } })).toBe('/xdg/wevir');
    expect(resolveHome({ ...linux, env: {} })).toBe('/home/u/.local/share/wevir');
    expect(resolveHome({ ...linux, env: { XDG_DATA_HOME: 'relative' } })).toBe(
      '/home/u/.local/share/wevir',
    );
  });
});

describe('homePath', () => {
  it('数据目录下的固定位置；数据目录必须是绝对路径', () => {
    expect(homePath('/data', 'runDir')).toMatch(/[/\\]data[/\\]run$/);
    expect(homePath('/data', 'logsDir')).toMatch(/[/\\]logs$/);
    expect(homePath('/data', 'hostIdFile')).toMatch(/[/\\]host-id$/);
    expect(() => homePath('data', 'runDir')).toThrow('绝对路径');
  });
});
