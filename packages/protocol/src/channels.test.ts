import { describe, expect, it } from 'vitest';
import {
  ChannelActivityKindSchema,
  ChannelMethodSchemas,
  ChannelPostParamsSchema,
  ChannelPostSchema,
  ChannelReactParamsSchema,
} from './channels.js';

describe('channel chat', () => {
  const post = {
    id: 'cpo_reply',
    channelId: 'chn_bot',
    seq: 2,
    author: { kind: 'user' },
    content: [{ type: 'text', text: 'Following up' }],
    createdAt: '2026-11-16T01:00:00.000Z',
  };

  it('keeps legacy posts and optional chat fields', () => {
    expect(ChannelPostSchema.parse(post)).toEqual(post);
    const reply = {
      ...post,
      replyTo: 'cpo_root',
      replyCount: 1,
      reactions: [
        { emoji: '👍', by: 'user' },
        { emoji: '✅', by: 'assistant' },
      ],
    };
    expect(ChannelPostSchema.parse(reply)).toEqual(reply);
    expect(ChannelPostSchema.safeParse({ ...post, replyCount: 0 }).success).toBe(false);
    expect(
      ChannelPostParamsSchema.parse({
        channelId: 'chn_bot',
        content: post.content,
        replyTo: 'cpo_root',
      }).replyTo,
    ).toBe('cpo_root');
  });

  it('permits removing reactions, bounds wire size and requires write permission', () => {
    const params = { channelId: 'chn_bot', postId: 'cpo_root', emoji: null };
    expect(ChannelReactParamsSchema.parse(params)).toEqual(params);
    expect(ChannelReactParamsSchema.safeParse({ ...params, emoji: 'a'.repeat(17) }).success).toBe(
      false,
    );
    expect(ChannelMethodSchemas['channel.react'].permission).toBe('session.write');
    expect(ChannelActivityKindSchema.safeParse('command text').success).toBe(false);
  });
});
