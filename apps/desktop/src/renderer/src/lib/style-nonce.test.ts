import { describe, expect, it } from 'vitest';
import { installStyleNonce } from './style-nonce';

class FakeDocument {
  createElement(tagName: string): HTMLElement {
    return { localName: tagName.toLowerCase(), nonce: '' } as HTMLElement;
  }
}

describe('installStyleNonce', () => {
  it('只给 <style> 盖 nonce，其他元素原样', () => {
    installStyleNonce(FakeDocument.prototype, 'abc');
    const doc = new FakeDocument();
    expect(doc.createElement('style').nonce).toBe('abc');
    expect(doc.createElement('STYLE').nonce).toBe('abc');
    expect(doc.createElement('script').nonce).toBe('');
    expect(doc.createElement('div').nonce).toBe('');
  });
});
