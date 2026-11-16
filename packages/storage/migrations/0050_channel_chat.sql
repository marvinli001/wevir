ALTER TABLE channel_posts ADD COLUMN reactions_json TEXT;
CREATE INDEX channel_posts_replies ON channel_posts(channel_id, reply_to);
