import {
  IMAGE_MAX_PER_MESSAGE,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_TEXT_MAX_LENGTH,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type ComposerDraft, draftFor, draftIssue, finishComposerSend } from './composer-drafts';
import { detectMentionTrigger } from './composer-trigger';

const blank: ComposerDraft = { text: '', pastes: [], attachments: [] };
const pdf = {
  key: 'pdf',
  kind: 'file' as const,
  name: 'Invoice.pdf',
  size: 4,
  blob: new Blob(['data']),
};
const paste = { key: 'paste', text: 'Quarterly results' };

describe('session composer drafts', () => {
  it('counts the original pasted text, all attachment types and the byte total', () => {
    expect(
      draftIssue({
        ...blank,
        text: 'x',
        pastes: [{ ...paste, text: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH - 1) }],
      }),
    ).toBeUndefined();
    expect(
      draftIssue({
        ...blank,
        text: 'xx',
        pastes: [{ ...paste, text: 'x'.repeat(MESSAGE_TEXT_MAX_LENGTH - 1) }],
      }),
    ).toBeDefined();
    expect(
      draftIssue({ ...blank, attachments: [{ ...pdf, size: MESSAGE_ATTACHMENT_MAX_BYTES }] }),
    ).toBeUndefined();
    expect(
      draftIssue({ ...blank, attachments: [{ ...pdf, size: MESSAGE_ATTACHMENT_MAX_BYTES }, pdf] }),
    ).toBeDefined();
    expect(
      draftIssue({
        ...blank,
        attachments: Array.from({ length: IMAGE_MAX_PER_MESSAGE + 1 }, () => pdf),
      }),
    ).toBeDefined();
  });
  it('records the first input in the created session and keeps changes typed while sending', async () => {
    const initial = { text: 'review', pastes: [paste], attachments: [pdf] };
    const newSession = draftFor('ses_created');
    draftFor('home').edit(() => ({ ...initial, text: 'next message' }));
    await finishComposerSend('home', initial, 'ses_created');
    await newSession.loaded;
    expect(draftFor('home').get().draft).toEqual({ ...blank, text: 'next message' });
    expect((await draftFor('home').history.search('')).items).toHaveLength(0);
    const page = await newSession.history.search('quarterLY');
    expect(page.items).toHaveLength(1);
    expect((await newSession.history.search('invoice')).items).toEqual(page.items);
    expect((await newSession.history.search('other')).items).toEqual([]);
    const previous = await newSession.history.read(page.items[0]?.id ?? '');
    expect(await previous?.attachments[0]?.blob?.text()).toBe('data');
  });
  it('can find and page back to the first of more than fifty sent inputs', async () => {
    const store = draftFor('ses_long_inputs');
    for (let i = 0; i < 64; i++)
      await finishComposerSend('ses_long_inputs', {
        ...blank,
        text: `prompt ${i.toString().padStart(2, '0')}`,
      });
    const first = await store.history.search('');
    expect(first.more).toBe(true);
    expect(first.items[0]?.title).toBe('prompt 63');
    const second = await store.history.search('', first.items.at(-1)?.id);
    expect(second.more).toBe(false);
    expect(second.items.at(-1)?.title).toBe('prompt 00');
    const early = await store.history.search('prompt 00');
    expect(early.items).toEqual([second.items.at(-1)]);
    expect(early.items[0]).not.toHaveProperty('attachments');
  });
  it('detects skill and file mentions independently at the caret', () => {
    expect(detectMentionTrigger('use $design then', 11, '$')).toEqual({
      query: 'design',
      rangeStart: 4,
      rangeEnd: 11,
    });
    expect(detectMentionTrigger('literal$design', 14, '$')).toBeNull();
    expect(detectMentionTrigger('$design', 7)).toBeNull();
  });
});
