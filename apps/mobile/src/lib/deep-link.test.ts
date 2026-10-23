import { describe, expect, it } from 'vitest';
import { pairingLinkFromPath, redirectSystemPath } from './deep-link';
import { pairingLink } from './test-utils';

describe('deep links', () => {
  it('sends pairing links to the add screen untouched', () => {
    const link = pairingLink();
    expect(redirectSystemPath(link)).toBe(`/add?link=${encodeURIComponent(link)}`);
    const query = link.slice('wevir://pair?'.length);
    expect(pairingLinkFromPath(`/pair?${query}`)).toBe(link);
    expect(pairingLinkFromPath(`pair?${query}`)).toBe(link);
  });

  it('leaves other paths alone', () => {
    expect(redirectSystemPath('/computer/studio')).toBe('/computer/studio');
    expect(pairingLinkFromPath('wevir://other')).toBeUndefined();
  });
});
