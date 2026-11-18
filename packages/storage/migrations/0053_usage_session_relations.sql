-- Usage remains queryable after a session is deleted.
CREATE TABLE usage_session_relations (
  session_id TEXT PRIMARY KEY,
  owner_session_id TEXT NOT NULL
) STRICT;

CREATE INDEX usage_session_relations_owner
  ON usage_session_relations(owner_session_id);

CREATE VIEW usage_session_owners AS
  SELECT id AS session_id,
    COALESCE(parent_session_id, CASE
      WHEN json_extract(origin, '$.kind') = 'second_opinion'
      THEN json_extract(origin, '$.sessionId') END) AS owner_session_id
  FROM sessions;

INSERT INTO usage_session_relations (session_id, owner_session_id)
  SELECT session_id, owner_session_id FROM usage_session_owners
  WHERE owner_session_id IS NOT NULL;

CREATE TRIGGER usage_session_relate AFTER INSERT ON sessions BEGIN
  INSERT INTO usage_session_relations (session_id, owner_session_id)
    SELECT session_id, owner_session_id FROM usage_session_owners
    WHERE session_id = NEW.id AND owner_session_id IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET owner_session_id = excluded.owner_session_id;
END;

CREATE TRIGGER usage_session_reparent AFTER UPDATE OF parent_session_id, origin ON sessions BEGIN
  DELETE FROM usage_session_relations WHERE session_id = NEW.id;
  INSERT INTO usage_session_relations (session_id, owner_session_id)
    SELECT session_id, owner_session_id FROM usage_session_owners
    WHERE session_id = NEW.id AND owner_session_id IS NOT NULL;
END;

UPDATE usage_records
  SET workspace_id = (SELECT workspace_id FROM sessions WHERE sessions.id = usage_records.session_id)
  WHERE workspace_id IS NULL;
