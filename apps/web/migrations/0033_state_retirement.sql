-- Release A of the state-inheritance retirement protocol (Tines/522).
--
-- Holds are durable and explicit: merely applying this additive migration has
-- no effect. Once an owner acquires a hold, the triggers below also protect an
-- older worker while the affected states drain and guidance is preserved.

CREATE TABLE `state_retirement_hold` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`actor_key` TEXT NOT NULL,
	`topology_digest` TEXT NOT NULL,
	`inventory_digest` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`released_at` INTEGER,
	UNIQUE (`user_id`, `id`)
);
CREATE INDEX `state_retirement_hold_owner_time_idx`
	ON `state_retirement_hold` (`user_id`, `created_at` DESC);
CREATE INDEX `state_retirement_hold_active_owner_idx`
	ON `state_retirement_hold` (`user_id`) WHERE `released_at` IS NULL;

CREATE TABLE `state_retirement_hold_state` (
	`hold_id` TEXT NOT NULL,
	`user_id` TEXT NOT NULL,
	`state_id` TEXT NOT NULL,
	`workflow_name` TEXT NOT NULL,
	`state_name` TEXT NOT NULL,
	`state_category` TEXT NOT NULL,
	PRIMARY KEY (`hold_id`, `state_id`),
	FOREIGN KEY (`user_id`, `hold_id`)
		REFERENCES `state_retirement_hold` (`user_id`, `id`) ON DELETE CASCADE
);
CREATE INDEX `state_retirement_hold_state_owner_state_idx`
	ON `state_retirement_hold_state` (`user_id`, `state_id`);

CREATE TABLE `state_retirement_receipt` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`hold_id` TEXT NOT NULL,
	`actor_key` TEXT NOT NULL,
	`kind` TEXT NOT NULL CHECK (`kind` IN ('preserve', 'rollback')),
	`rollback_of_receipt_id` TEXT REFERENCES `state_retirement_receipt` (`id`),
	`inventory_digest` TEXT NOT NULL,
	`plan_digest` TEXT NOT NULL,
	`request_digest` TEXT NOT NULL,
	`execution_nonce` TEXT NOT NULL,
	`receipt_json` TEXT NOT NULL,
	`committed_at` INTEGER NOT NULL,
	CHECK (
		(`kind` = 'preserve' AND `rollback_of_receipt_id` IS NULL)
		OR (`kind` = 'rollback' AND `rollback_of_receipt_id` IS NOT NULL)
	),
	FOREIGN KEY (`user_id`, `hold_id`)
		REFERENCES `state_retirement_hold` (`user_id`, `id`) ON DELETE RESTRICT,
	UNIQUE (`user_id`, `id`)
);
CREATE INDEX `state_retirement_receipt_owner_time_idx`
	ON `state_retirement_receipt` (`user_id`, `committed_at` DESC);
CREATE UNIQUE INDEX `state_retirement_receipt_request_idx`
	ON `state_retirement_receipt` (`user_id`, `request_digest`);

CREATE TABLE `state_retirement_pointer` (
	`hold_id` TEXT NOT NULL,
	`user_id` TEXT NOT NULL,
	`child_state_id` TEXT NOT NULL,
	`original_parent_state_id` TEXT NOT NULL,
	`state_witness` TEXT NOT NULL,
	`successful_receipt_id` TEXT REFERENCES `state_retirement_receipt` (`id`),
	PRIMARY KEY (`hold_id`, `child_state_id`),
	FOREIGN KEY (`user_id`, `hold_id`)
		REFERENCES `state_retirement_hold` (`user_id`, `id`) ON DELETE CASCADE
);
CREATE INDEX `state_retirement_pointer_owner_child_idx`
	ON `state_retirement_pointer` (`user_id`, `child_state_id`);

CREATE TRIGGER `state_retirement_hold_state_exclusive`
BEFORE INSERT ON `state_retirement_hold_state`
WHEN EXISTS (
	SELECT 1
	FROM `state_retirement_hold_state` hs
	JOIN `state_retirement_hold` existing ON existing.`id` = hs.`hold_id`
	JOIN `state_retirement_hold` incoming ON incoming.`id` = NEW.`hold_id`
	WHERE hs.`user_id` = NEW.`user_id`
		AND hs.`state_id` = NEW.`state_id`
		AND hs.`hold_id` != NEW.`hold_id`
		AND existing.`released_at` IS NULL
		AND incoming.`released_at` IS NULL
)
BEGIN
	SELECT RAISE(ABORT, 'state_retirement_state_already_held');
END;

-- A rollback batch inserts one authorization immediately before restoring the
-- exact recorded edge. The AFTER trigger consumes it in the same transaction,
-- so it cannot become a lasting bypass for normal workflow writes.
CREATE TABLE `state_retirement_restore_authorization` (
	`receipt_id` TEXT NOT NULL REFERENCES `state_retirement_receipt` (`id`) ON DELETE CASCADE,
	`user_id` TEXT NOT NULL,
	`hold_id` TEXT NOT NULL,
	`child_state_id` TEXT NOT NULL,
	`parent_state_id` TEXT NOT NULL,
	`consumed_at` INTEGER,
	PRIMARY KEY (`receipt_id`, `child_state_id`),
	FOREIGN KEY (`hold_id`, `child_state_id`)
		REFERENCES `state_retirement_pointer` (`hold_id`, `child_state_id`) ON DELETE CASCADE
);

CREATE TRIGGER `state_retirement_agent_run_insert_guard`
BEFORE INSERT ON `agent_run`
WHEN NEW.`status` IN ('assigned', 'launching', 'running')
	AND EXISTS (
		SELECT 1
		FROM `state_retirement_hold` h
		JOIN `state_retirement_hold_state` hs ON hs.`hold_id` = h.`id`
		WHERE h.`user_id` = NEW.`user_id`
			AND h.`released_at` IS NULL
			AND hs.`state_id` = NEW.`state_id_at_start`
	)
BEGIN
	SELECT RAISE(IGNORE);
END;

CREATE TRIGGER `state_retirement_agent_run_resurrection_guard`
BEFORE UPDATE OF `status` ON `agent_run`
WHEN OLD.`status` NOT IN ('assigned', 'launching', 'running')
	AND NEW.`status` IN ('assigned', 'launching', 'running')
	AND EXISTS (
		SELECT 1
		FROM `state_retirement_hold` h
		JOIN `state_retirement_hold_state` hs ON hs.`hold_id` = h.`id`
		WHERE h.`user_id` = NEW.`user_id`
			AND h.`released_at` IS NULL
			AND hs.`state_id` = NEW.`state_id_at_start`
	)
BEGIN
	SELECT RAISE(IGNORE);
END;

CREATE TRIGGER `state_retirement_pointer_insert_guard`
BEFORE INSERT ON `workflow_state`
WHEN NEW.`inherits_from_state_id` IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM `state_retirement_hold` h
		JOIN `workflow` w ON w.`user_id` = h.`user_id`
		WHERE h.`released_at` IS NULL AND w.`id` = NEW.`workflow_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'state_retirement_hold_active');
END;

CREATE TRIGGER `state_retirement_pointer_update_guard`
BEFORE UPDATE OF `inherits_from_state_id` ON `workflow_state`
WHEN NEW.`inherits_from_state_id` IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM `state_retirement_hold` h
		JOIN `workflow` w ON w.`user_id` = h.`user_id`
		WHERE h.`released_at` IS NULL AND w.`id` = NEW.`workflow_id`
	)
	AND NOT EXISTS (
		SELECT 1
		FROM `state_retirement_restore_authorization` a
		JOIN `state_retirement_receipt` r ON r.`id` = a.`receipt_id`
		JOIN `state_retirement_pointer` p
			ON p.`hold_id` = a.`hold_id` AND p.`child_state_id` = a.`child_state_id`
		WHERE a.`consumed_at` IS NULL
			AND a.`user_id` = r.`user_id`
			AND r.`kind` = 'rollback'
			AND r.`hold_id` = a.`hold_id`
			AND a.`child_state_id` = NEW.`id`
			AND a.`parent_state_id` = NEW.`inherits_from_state_id`
			AND p.`original_parent_state_id` = NEW.`inherits_from_state_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'state_retirement_hold_active');
END;

CREATE TRIGGER `state_retirement_pointer_restore_consume`
AFTER UPDATE OF `inherits_from_state_id` ON `workflow_state`
WHEN NEW.`inherits_from_state_id` IS NOT NULL
BEGIN
	UPDATE `state_retirement_restore_authorization`
	SET `consumed_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
	WHERE `consumed_at` IS NULL
		AND `child_state_id` = NEW.`id`
		AND `parent_state_id` = NEW.`inherits_from_state_id`;
END;
