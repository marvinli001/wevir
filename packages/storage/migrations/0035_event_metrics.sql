CREATE INDEX events_routing_decisions ON events (
  json_extract(payload, '$.at') DESC, session_id DESC, seq DESC
) WHERE type = 'routing.decided';

CREATE TABLE event_session_metrics (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE event_image_refs (
  image_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  PRIMARY KEY (image_id, session_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX event_image_refs_by_session ON event_image_refs (session_id);

INSERT INTO event_session_metrics (session_id, payload_bytes)
SELECT session_id, SUM(length(CAST(payload AS BLOB))) FROM events GROUP BY session_id;

INSERT OR IGNORE INTO event_image_refs (image_id, session_id)
SELECT j.value, e.session_id FROM events e, json_tree(e.payload) j
WHERE e.payload LIKE '%"imageId":"%' AND j.key = 'imageId' AND j.type = 'text'
  AND j.value <> '' AND instr(json_quote(j.value), char(92)) = 0;

CREATE TRIGGER events_insert_metrics AFTER INSERT ON events BEGIN
  INSERT INTO event_session_metrics (session_id, payload_bytes)
  VALUES (NEW.session_id, length(CAST(NEW.payload AS BLOB)))
  ON CONFLICT (session_id) DO UPDATE SET payload_bytes = payload_bytes + excluded.payload_bytes;
END;

CREATE TRIGGER events_insert_image_refs AFTER INSERT ON events
WHEN instr(NEW.payload, '"imageId":"') > 0 BEGIN
  INSERT OR IGNORE INTO event_image_refs (image_id, session_id)
  SELECT value, NEW.session_id FROM json_tree(NEW.payload)
  WHERE key = 'imageId' AND type = 'text' AND value <> ''
    AND instr(json_quote(value), char(92)) = 0;
END;
