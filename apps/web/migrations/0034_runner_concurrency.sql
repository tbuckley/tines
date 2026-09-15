ALTER TABLE runner ADD COLUMN concurrency_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (concurrency_mode IN ('legacy', 'local', 'remote'));
ALTER TABLE runner ADD COLUMN concurrency_ceiling INTEGER
  CHECK (concurrency_ceiling IS NULL OR concurrency_ceiling BETWEEN 1 AND 100);
ALTER TABLE runner ADD COLUMN concurrency_requested INTEGER
  CHECK (concurrency_requested IS NULL OR concurrency_requested BETWEEN 1 AND 100);
ALTER TABLE runner ADD COLUMN concurrency_revision INTEGER NOT NULL DEFAULT 0
  CHECK (concurrency_revision >= 0);
ALTER TABLE runner ADD COLUMN concurrency_instance_id TEXT;
ALTER TABLE runner ADD COLUMN concurrency_applied_revision INTEGER
  CHECK (concurrency_applied_revision IS NULL OR concurrency_applied_revision >= 0);
ALTER TABLE runner ADD COLUMN concurrency_applied_cap INTEGER
  CHECK (concurrency_applied_cap IS NULL OR concurrency_applied_cap BETWEEN 1 AND 100);
ALTER TABLE runner ADD COLUMN concurrency_applied_instance_id TEXT;
ALTER TABLE runner ADD COLUMN concurrency_applied_at INTEGER;
ALTER TABLE runner ADD COLUMN concurrency_unavailable_reason TEXT
  CHECK (concurrency_unavailable_reason IS NULL OR concurrency_unavailable_reason IN
    ('legacy', 'opted_out', 'awaiting_policy', 'unsupported_protocol', 'invalid_protocol', 'offline'));
