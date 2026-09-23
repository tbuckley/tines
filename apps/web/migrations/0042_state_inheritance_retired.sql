-- Release B of the state-inheritance retirement protocol (Tines/522).
--
-- This migration is deliberately fail-closed. D1 runs migrations in a
-- transaction: the barrier INSERT must succeed before the permanent guards
-- are installed. It never repairs or clears a leftover pointer.

CREATE TABLE `state_inheritance_retirement_barrier` (
	`id` INTEGER PRIMARY KEY CHECK (`id` = 1),
	`pointer_count` INTEGER NOT NULL CHECK (`pointer_count` = 0),
	`unresolved_receipt_count` INTEGER NOT NULL CHECK (`unresolved_receipt_count` = 0),
	`checked_at` INTEGER NOT NULL
);

INSERT INTO `state_inheritance_retirement_barrier`
	(`id`, `pointer_count`, `unresolved_receipt_count`, `checked_at`)
VALUES (
	1,
	(SELECT COUNT(*) FROM `workflow_state` WHERE `inherits_from_state_id` IS NOT NULL),
	(SELECT COUNT(*) FROM `state_retirement_pointer` WHERE `successful_receipt_id` IS NULL),
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Keep the old nullable column and index for schema compatibility. These
-- guards protect the interval in which an old A worker can still run against
-- the B schema and remain inert for ordinary null-pointer writes.
CREATE TRIGGER `state_inheritance_retired_insert_guard`
BEFORE INSERT ON `workflow_state`
WHEN NEW.`inherits_from_state_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'state_inheritance_removed');
END;

CREATE TRIGGER `state_inheritance_retired_update_guard`
BEFORE UPDATE OF `inherits_from_state_id` ON `workflow_state`
WHEN NEW.`inherits_from_state_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'state_inheritance_removed');
END;
