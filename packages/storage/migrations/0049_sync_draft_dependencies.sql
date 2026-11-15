CREATE TABLE sync_draft_dependencies (
  vault_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  dependency TEXT NOT NULL,
  PRIMARY KEY (vault_id, op_id, dependency),
  FOREIGN KEY (vault_id, op_id) REFERENCES sync_drafts(vault_id, op_id) ON DELETE CASCADE ON UPDATE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX sync_draft_dependency ON sync_draft_dependencies(vault_id, dependency, op_id);

INSERT INTO sync_draft_dependencies (vault_id, op_id, dependency)
SELECT vault_id, op_id, dependency FROM (
  SELECT d.vault_id, d.op_id, p.value AS dependency FROM sync_drafts d, json_each(d.parents) p
  UNION
  SELECT d.vault_id, d.op_id, json_extract(p.value,'$.opId') FROM sync_drafts d,
    json_each(d.content,'$.body.files') f, json_each(f.value,'$.parts') p
    WHERE json_extract(d.content,'$.body.schema')='wevir-bundle/1'
  UNION
  SELECT d.vault_id, d.op_id, json_extract(r.value,'$.opId') FROM sync_drafts d,
    json_each(d.content,'$.body.metadata.ruleVersions') r
    WHERE json_extract(d.content,'$.body.schema')='wevir-bundle/1'
) WHERE dependency IS NOT NULL;

CREATE TRIGGER sync_draft_dependencies_insert AFTER INSERT ON sync_drafts BEGIN
  INSERT OR IGNORE INTO sync_draft_dependencies (vault_id, op_id, dependency)
  SELECT NEW.vault_id, NEW.op_id, dependency FROM (
    SELECT p.value AS dependency FROM json_each(NEW.parents) p
    UNION
    SELECT json_extract(p.value,'$.opId') FROM json_each(NEW.content,'$.body.files') f,
      json_each(f.value,'$.parts') p WHERE json_extract(NEW.content,'$.body.schema')='wevir-bundle/1'
    UNION
    SELECT json_extract(r.value,'$.opId') FROM json_each(NEW.content,'$.body.metadata.ruleVersions') r
      WHERE json_extract(NEW.content,'$.body.schema')='wevir-bundle/1'
  ) WHERE dependency IS NOT NULL;
END;

CREATE TRIGGER sync_draft_dependencies_update AFTER UPDATE OF parents, content ON sync_drafts BEGIN
  DELETE FROM sync_draft_dependencies WHERE vault_id=NEW.vault_id AND op_id=NEW.op_id;
  INSERT OR IGNORE INTO sync_draft_dependencies (vault_id, op_id, dependency)
  SELECT NEW.vault_id, NEW.op_id, dependency FROM (
    SELECT p.value AS dependency FROM json_each(NEW.parents) p
    UNION
    SELECT json_extract(p.value,'$.opId') FROM json_each(NEW.content,'$.body.files') f,
      json_each(f.value,'$.parts') p WHERE json_extract(NEW.content,'$.body.schema')='wevir-bundle/1'
    UNION
    SELECT json_extract(r.value,'$.opId') FROM json_each(NEW.content,'$.body.metadata.ruleVersions') r
      WHERE json_extract(NEW.content,'$.body.schema')='wevir-bundle/1'
  ) WHERE dependency IS NOT NULL;
END;
