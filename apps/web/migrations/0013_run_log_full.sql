-- Durable full run logs (Tines/66): the 256 KB D1 tail stays exactly as it
-- is; bytes it evicts spill to R2 instead of being lost. These columns are
-- the bookkeeping for that spill — which parts exist, which are compacted,
-- whether the run's log has been sealed into one object, and when retention
-- deleted the objects. Pre-existing runs default to "never spilled", so the
-- read path falls back to the tail for them.
ALTER TABLE agent_run ADD COLUMN log_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN log_part_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN log_compacted_through INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN log_sealed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN log_raw_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_run ADD COLUMN log_objects_deleted_at INTEGER;
