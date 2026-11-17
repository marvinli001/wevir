CREATE TABLE user_attachment_refs (
  attachment_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  PRIMARY KEY (attachment_id, owner_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_attachment_refs_by_owner ON user_attachment_refs(owner_id);

-- image references in session events already live in event_image_refs.
CREATE TRIGGER events_insert_file_refs AFTER INSERT ON events
WHEN NEW.type IN ('user.message', 'user.steered', 'turn.started', 'pending.added', 'pending.updated')
 AND instr(NEW.payload, '"fileId":') > 0 BEGIN
  INSERT OR IGNORE INTO user_attachment_refs
  SELECT json_extract(p.value, '$.fileId'), NEW.session_id
  FROM json_each(NEW.payload, CASE NEW.type
    WHEN 'turn.started' THEN '$.input'
    WHEN 'pending.added' THEN '$.pending.content'
    WHEN 'pending.updated' THEN '$.pending.content'
    ELSE '$.content' END) p
  WHERE p.type = 'object' AND json_extract(p.value, '$.type') = 'file';
END;
CREATE TRIGGER sessions_delete_attachment_refs AFTER DELETE ON sessions BEGIN
  DELETE FROM user_attachment_refs WHERE owner_id = OLD.id;
END;

INSERT OR IGNORE INTO user_attachment_refs
SELECT json_extract(p.value, '$.imageId'), c.channel_id
FROM channel_posts c, json_each(c.content) p
WHERE p.type = 'object' AND json_extract(p.value, '$.type') = 'image';
CREATE TRIGGER posts_insert_attachment_refs AFTER INSERT ON channel_posts BEGIN
  INSERT OR IGNORE INTO user_attachment_refs
  SELECT COALESCE(json_extract(p.value, '$.fileId'), json_extract(p.value, '$.imageId')), NEW.channel_id
  FROM json_each(NEW.content) p
  WHERE p.type = 'object' AND json_extract(p.value, '$.type') IN ('image','file');
END;
CREATE TRIGGER channels_delete_attachment_refs AFTER DELETE ON channels BEGIN
  DELETE FROM user_attachment_refs WHERE owner_id = OLD.id;
END;
