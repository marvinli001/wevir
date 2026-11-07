CREATE INDEX events_by_session_type_turn ON events (
  session_id, type, json_extract(payload, '$.turnId'), seq
);
