-- Archiving a project freezes it: schedules stop firing, nothing new
-- dispatches, and every write anchored on the project or its issues is
-- refused, while everything stays readable. NULL = live; the value is the
-- archive instant (ms). The index serves the per-user list defaults, which
-- exclude archived projects unless asked.
ALTER TABLE project ADD COLUMN archived_at INTEGER;
CREATE INDEX IF NOT EXISTS project_user_archived_idx ON project(user_id, archived_at);
