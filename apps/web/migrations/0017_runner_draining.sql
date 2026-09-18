-- A local runner's daemon reports `draining` on its poll while it finishes
-- its in-flight runs before exiting for a self-update restart. The
-- dispatcher assigns nothing to a draining runner; the relaunched daemon's
-- first poll clears it. 0/1; every runner predating this column is not
-- draining.
ALTER TABLE runner ADD COLUMN draining INTEGER NOT NULL DEFAULT 0;
