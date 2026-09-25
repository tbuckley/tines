-- The run that filed an issue, if any. A run treats the issues it files as
-- its own for the rest of that run: it can label, comment on, attach to,
-- link, edit and transition them without its stage's wider run scope.
ALTER TABLE issue ADD COLUMN created_by_run_id TEXT;
CREATE INDEX IF NOT EXISTS issue_created_by_run_id ON issue (created_by_run_id)
	WHERE created_by_run_id IS NOT NULL;
