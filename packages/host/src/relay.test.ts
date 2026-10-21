import type { MessageFrom, SessionId, UserContentPart } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { relayContent } from './relay.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const text = (value: string): UserContentPart => ({ type: 'text', text: value });

describe('relayContent', () => {
  it('leaves the user’s own messages alone', () => {
    const content = [text('fix the build')];
    expect(relayContent(undefined, content)).toEqual(content);
  });

  it('wraps a message from another session with matching ids on both tags', () => {
    const from: MessageFrom = { sessionId: SESSION, kind: 'message', reportBack: true };
    expect(relayContent(from, [text('run the tests')], 'abc123')).toEqual([
      text(
        `<relayed_message id="abc123" trust="relay" kind="message" from="session ${SESSION}">\nrun the tests\n</relayed_message id="abc123">`,
      ),
    ]);
  });

  it('names the background process of a notice and escapes attribute values', () => {
    const from: MessageFrom = {
      sessionId: SESSION,
      kind: 'report',
      process: { id: 'p1', name: 'pnpm "dev"', event: 'exit', exitCode: 1 },
    };
    const [part] = relayContent(from, [text('[Wevir] Background process p1 exited.')], 'id');
    expect(part).toEqual(
      text(
        '<relayed_message id="id" trust="relay" kind="process_notice" from="background process p1 (pnpm &quot;dev&quot;)">\n[Wevir] Background process p1 exited.\n</relayed_message id="id">',
      ),
    );
  });

  it('opens before the first text part and closes after the last', () => {
    const image: UserContentPart = {
      type: 'image',
      imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' as never,
      mimeType: 'image/png',
      size: 10,
    };
    const from: MessageFrom = { sessionId: SESSION, kind: 'report' };
    const wrapped = relayContent(from, [image, text('a'), text('b')], 'x');
    expect(wrapped[0]).toBe(image);
    expect(wrapped[1]).toEqual(
      text(`<relayed_message id="x" trust="relay" kind="report" from="session ${SESSION}">\na`),
    );
    expect(wrapped[2]).toEqual(text('b\n</relayed_message id="x">'));
  });

  it('uses a fresh random id each time', () => {
    const from: MessageFrom = { sessionId: SESSION, kind: 'message' };
    const [a] = relayContent(from, [text('hi')]);
    const [b] = relayContent(from, [text('hi')]);
    expect(a).not.toEqual(b);
  });

  it('does not wrap automatic repair or a quoted second opinion', () => {
    const repair = { sessionId: SESSION, kind: 'report', repair: {} } as unknown as MessageFrom;
    const opinion = {
      sessionId: SESSION,
      kind: 'report',
      opinion: { opinionId: 'opn_x' },
    } as unknown as MessageFrom;
    expect(relayContent(repair, [text('fix it')])).toEqual([text('fix it')]);
    expect(relayContent(opinion, [text('note')])).toEqual([text('note')]);
  });
});
