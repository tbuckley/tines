-- Housekeeping state for sweep passes that walk something bigger than one
-- pass can cover (Tines/66). The run-log orphan pass lists the R2 keyspace a
-- page at a time; without a remembered position every sweep would re-read the
-- same lexicographically-first page and never reach orphans deeper in.
--
-- Deliberately global and singleton-per-key rather than per-user: the objects
-- it walks outlive their users (a cascaded user delete leaves keys behind),
-- so there is no user row to hang the position off.
CREATE TABLE `supervisor_sweep_state` (
	`key` TEXT NOT NULL PRIMARY KEY,
	`value` TEXT,
	`updated_at` INTEGER NOT NULL
);
