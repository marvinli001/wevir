import { describe, expect, it } from 'vitest';
import { addressToUrl, isAllowedNavigation, isAllowedRequest } from './url-policy.js';

describe('内置浏览器的地址规则', () => {
  it('页面只能是 http(s)', () => {
    expect(isAllowedNavigation('http://localhost:5173/')).toBe(true);
    expect(isAllowedNavigation('https://example.com/a')).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'wevir://app/index.html',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'mailto:a@b.c',
      'zoommtg://zoom.us/join',
      'not a url',
    ]) {
      expect(isAllowedNavigation(url), url).toBe(false);
    }
  });

  it('请求关口：主框架只放行 http(s) 与 about:blank，子框架另有 data / blob，资源另有 ws(s)', () => {
    expect(isAllowedRequest('about:blank', 'mainFrame')).toBe(true);
    expect(isAllowedRequest('data:text/html,x', 'mainFrame')).toBe(false);
    expect(isAllowedRequest('file:///tmp/x.html', 'mainFrame')).toBe(false);
    expect(isAllowedRequest('data:text/html,x', 'subFrame')).toBe(true);
    expect(isAllowedRequest('file:///tmp/x.html', 'subFrame')).toBe(false);
    expect(isAllowedRequest('data:image/png;base64,AAAA', 'image')).toBe(true);
    expect(isAllowedRequest('wss://example.com/socket', 'webSocket')).toBe(true);
    expect(isAllowedRequest('file:///etc/hosts', 'xhr')).toBe(false);
    expect(isAllowedRequest('wevir://app/index.js', 'script')).toBe(false);
  });

  it('地址栏：本机地址补 http，其余补 https，别的协议与空白不认', () => {
    expect(addressToUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(addressToUrl('127.0.0.1:3000/a')).toBe('http://127.0.0.1:3000/a');
    expect(addressToUrl('example.com')).toBe('https://example.com/');
    expect(addressToUrl(' https://example.com/x?y=1 ')).toBe('https://example.com/x?y=1');
    for (const value of [
      '',
      'two words',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'mailto:a@b',
    ]) {
      expect(addressToUrl(value), value).toBeUndefined();
    }
  });
});
