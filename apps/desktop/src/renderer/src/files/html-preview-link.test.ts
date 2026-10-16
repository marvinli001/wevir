import { describe, expect, it } from 'vitest';
import { openLinkResult, readOpenLinkRequest } from './html-preview-link';

describe('readOpenLinkRequest（T3 的 readHtmlRenderLinkRequest）', () => {
  it('只认 http(s) 的 ui/open-link', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'wevir-link-1',
      method: 'ui/open-link',
      params: { url: 'https://example.com/a', metaKey: false },
    };
    expect(readOpenLinkRequest(request)).toEqual({
      id: 'wevir-link-1',
      url: 'https://example.com/a',
    });
    expect(
      readOpenLinkRequest({ ...request, params: { url: 'javascript:alert(1)' } }),
    ).toBeUndefined();
    expect(
      readOpenLinkRequest({ ...request, params: { url: 'file:///etc/passwd' } }),
    ).toBeUndefined();
    expect(readOpenLinkRequest({ ...request, method: 'ui/other' })).toBeUndefined();
    expect(readOpenLinkRequest({ ...request, id: null })).toBeUndefined();
    expect(readOpenLinkRequest('ui/open-link')).toBeUndefined();
    expect(openLinkResult(3)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });
});
