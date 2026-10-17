import type { BrowserNetworkEntry } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  filterNetwork,
  isTextMime,
  parseStatusFilter,
  redactHeaders,
  responseBody,
} from './network.js';

const timing = { startTime: 0, duration: 1 };
const entries: BrowserNetworkEntry[] = [
  { id: '1', url: 'https://a.test/', method: 'GET', status: 200, type: 'document', ...timing },
  {
    id: '2',
    url: 'https://a.test/api/items',
    method: 'POST',
    status: 201,
    type: 'fetch',
    ...timing,
  },
  {
    id: '3',
    url: 'https://a.test/missing.png',
    method: 'GET',
    status: 404,
    type: 'image',
    ...timing,
  },
  {
    id: '4',
    url: 'https://cdn.test/app.js',
    method: 'GET',
    status: 503,
    type: 'script',
    ...timing,
  },
  {
    id: '5',
    url: 'https://a.test/api/slow',
    method: 'GET',
    type: 'fetch',
    failed: 'net::ERR_ABORTED',
    ...timing,
  },
];

describe('redactHeaders', () => {
  it('replaces credential headers with their length and keeps the rest', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer secret',
        Cookie: 'sid=1',
        'X-Api-Key': 'k',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Authorization: '[redacted, 13 characters]',
      Cookie: '[redacted, 5 characters]',
      'X-Api-Key': '[redacted, 1 characters]',
      'Content-Type': 'application/json',
    });
  });

  it('cuts very long values and accepts no headers', () => {
    expect(redactHeaders({ 'X-Long': 'a'.repeat(3_000) })['X-Long']).toHaveLength(2_001);
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe('parseStatusFilter', () => {
  it('reads an exact code, a family and a range', () => {
    expect(parseStatusFilter('404')?.(404)).toBe(true);
    expect(parseStatusFilter('404')?.(403)).toBe(false);
    expect(parseStatusFilter('4XX')?.(499)).toBe(true);
    expect(parseStatusFilter('4xx')?.(500)).toBe(false);
    expect(parseStatusFilter('4xx')?.(undefined)).toBe(false);
    expect(parseStatusFilter('200 - 299')?.(201)).toBe(true);
    expect(parseStatusFilter('200-299')?.(300)).toBe(false);
  });

  it('rejects other forms', () => {
    expect(parseStatusFilter('ok')).toBeNull();
    expect(parseStatusFilter('6xx')).toBeNull();
    expect(parseStatusFilter('499-400')).toBeNull();
  });
});

describe('filterNetwork', () => {
  const ids = (filter: Parameters<typeof filterNetwork>[1]) =>
    filterNetwork(entries, filter).map((entry) => entry.id);

  it('filters by URL part, method, type and status', () => {
    expect(ids({ url: '/API/' })).toEqual(['2', '5']);
    expect(ids({ method: 'post' })).toEqual(['2']);
    expect(ids({ type: 'FETCH' })).toEqual(['2', '5']);
    expect(ids({ status: '4xx' })).toEqual(['3']);
    expect(ids({ url: 'a.test', method: 'GET', status: '200' })).toEqual(['1']);
  });

  it('failedOnly keeps network errors and HTTP errors', () => {
    expect(ids({ failedOnly: true })).toEqual(['3', '4', '5']);
  });

  it('throws a TypeError for a status it cannot read', () => {
    expect(() => filterNetwork(entries, { status: 'bad' })).toThrow(TypeError);
  });
});

describe('responseBody', () => {
  it('returns text bodies and truncates them', () => {
    expect(responseBody({ body: '{"a":1}' }, 'application/json', 100)).toEqual({
      size: 7,
      text: '{"a":1}',
    });
    expect(responseBody({ body: 'abcdef' }, 'text/plain', 3)).toEqual({
      size: 6,
      text: 'abc',
      truncated: true,
    });
  });

  it('decodes base64 text and summarizes binary bodies', () => {
    expect(
      responseBody(
        { body: Buffer.from('<p>hi</p>').toString('base64'), base64Encoded: true },
        'text/html',
        100,
      ),
    ).toEqual({ size: 9, text: '<p>hi</p>' });
    const png = Buffer.from([137, 80, 78, 71, 0, 1, 2]).toString('base64');
    expect(responseBody({ body: png, base64Encoded: true }, 'image/png', 100)).toEqual({
      size: 7,
      binary: true,
    });
  });

  it('treats an undeclared body with NUL bytes as binary', () => {
    expect(responseBody({ body: 'a\u0000b' }, undefined, 100)).toEqual({ size: 3, binary: true });
    expect(responseBody({ body: 'plain' }, undefined, 100)).toEqual({ size: 5, text: 'plain' });
  });

  it('recognizes text MIME types', () => {
    expect(isTextMime('application/problem+json; charset=utf-8')).toBe(true);
    expect(isTextMime('image/svg+xml')).toBe(true);
    expect(isTextMime('application/octet-stream')).toBe(false);
    expect(isTextMime(undefined)).toBe(false);
  });
});
