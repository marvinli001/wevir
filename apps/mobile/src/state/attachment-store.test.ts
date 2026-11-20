import { describe, expect, it, vi } from 'vitest';
import {
  forgetAttachments,
  readAttachments,
  updateAttachments,
  watchAttachments,
} from './attachment-store';

const photo = (key: string) => ({ key, uri: `file:///${key}.jpg`, uploading: false });

describe('draft photos', () => {
  it('keeps photos for a draft after its page stops watching', () => {
    const stop = watchAttachments('mac/ses_a', () => {});
    updateAttachments('mac/ses_a', (current) => [...current, photo('one')]);
    stop();
    expect(readAttachments('mac/ses_a').map((a) => a.key)).toEqual(['one']);
    expect(readAttachments('mac/ses_b')).toEqual([]);
    updateAttachments('mac/ses_a', () => []);
    expect(readAttachments('mac/ses_a')).toEqual([]);
  });

  it('clears only the forgotten computer and tells its watchers', () => {
    updateAttachments('old/ses_a', () => [photo('old')]);
    updateAttachments('other/ses_a', () => [photo('other')]);
    const listener = vi.fn();
    const stop = watchAttachments('old/ses_a', listener);
    forgetAttachments('old');
    stop();
    expect(listener).toHaveBeenCalledOnce();
    expect(readAttachments('old/ses_a')).toEqual([]);
    expect(readAttachments('other/ses_a').map((a) => a.key)).toEqual(['other']);
  });
});
