import { describe, expect, it } from 'vitest';
import { loadFailure, loadFailureMessage } from './load-failure.js';

/** Electron 的 loadURL 拒绝时的错误（web-contents.ts：消息加上 code 与 errno）。 */
function electronError(name: string, errno: number, url: string): Error {
  return Object.assign(new Error(`${name} (${errno}) loading '${url}'`), {
    code: name,
    errno,
    url,
  });
}

describe('载入失败的原因', () => {
  it('报出 Chromium 的错误名、错误号与提示，不丢掉错误名', () => {
    const url = 'http://localhost:8765/';
    const failure = loadFailure(electronError('ERR_CONNECTION_REFUSED', -102, url), undefined);
    expect(failure).toMatchObject({ name: 'ERR_CONNECTION_REFUSED', errno: -102 });
    expect(loadFailureMessage(url, failure)).toBe(
      'Could not load http://localhost:8765/: ERR_CONNECTION_REFUSED (-102). Nothing accepted the connection: check that the server is running and the port is right.',
    );
  });

  it('没有 code 时从消息里读，再没有就用 did-fail-load 记下的', () => {
    expect(
      loadFailure(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'x'"), undefined),
    ).toMatchObject({ name: 'ERR_NAME_NOT_RESOLVED', errno: -105 });
    expect(
      loadFailure(new Error('boom'), { code: -201, description: 'ERR_CERT_DATE_INVALID' }),
    ).toMatchObject({ name: 'ERR_CERT_DATE_INVALID', errno: -201 });
    expect(loadFailureMessage('https://a.test/', loadFailure(new Error('boom'), undefined))).toBe(
      'Could not load https://a.test/: boom',
    );
  });

  it('不认识的错误名照样报出，只是没有提示', () => {
    const failure = loadFailure(
      electronError('ERR_BLOCKED_BY_CLIENT', -20, 'http://a.test/'),
      undefined,
    );
    expect(loadFailureMessage('http://a.test/', failure)).toBe(
      'Could not load http://a.test/: ERR_BLOCKED_BY_CLIENT (-20).',
    );
  });
});
