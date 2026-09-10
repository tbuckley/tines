-- Permanent issue addresses and project-assignment fencing for project transfer.

CREATE TABLE `issue_address` (
	`project_id` TEXT NOT NULL REFERENCES `project` (`id`) ON DELETE RESTRICT,
	`number` INTEGER NOT NULL CHECK (`number` > 0),
	`issue_id` TEXT NOT NULL REFERENCES `issue` (`id`) ON DELETE RESTRICT,
	`created_at` INTEGER NOT NULL,
	PRIMARY KEY (`project_id`, `number`)
);
CREATE INDEX `issue_address_issue_id_idx` ON `issue_address` (`issue_id`);

INSERT INTO `issue_address` (`project_id`, `number`, `issue_id`, `created_at`)
	SELECT `project_id`, `number`, `id`, `created_at` FROM `issue`;

ALTER TABLE `issue` ADD COLUMN `project_assignment_token` TEXT NOT NULL DEFAULT '';
ALTER TABLE `agent_run` ADD COLUMN `project_assignment_token` TEXT NOT NULL DEFAULT '';

CREATE TRIGGER `issue_address_after_insert`
AFTER INSERT ON `issue`
BEGIN
	INSERT INTO `issue_address` (`project_id`, `number`, `issue_id`, `created_at`)
	VALUES (NEW.`project_id`, NEW.`number`, NEW.`id`, NEW.`created_at`);
END;

CREATE TRIGGER `issue_address_after_move`
AFTER UPDATE OF `project_id`, `number` ON `issue`
WHEN OLD.`project_id` != NEW.`project_id` OR OLD.`number` != NEW.`number`
BEGIN
	INSERT INTO `issue_address` (`project_id`, `number`, `issue_id`, `created_at`)
	VALUES (NEW.`project_id`, NEW.`number`, NEW.`id`, NEW.`updated_at`);
END;

CREATE TRIGGER `context_item_issue_project_insert_coherent`
BEFORE INSERT ON `context_item`
WHEN NEW.`project_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `issue`
		WHERE `id` = NEW.`issue_id` AND `project_id` = NEW.`project_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'incoherent_issue_project_scope');
END;

CREATE TRIGGER `context_item_issue_project_update_coherent`
BEFORE UPDATE OF `project_id`, `issue_id` ON `context_item`
WHEN NEW.`project_id` IS NOT NULL AND NEW.`issue_id` IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM `issue`
		WHERE `id` = NEW.`issue_id` AND `project_id` = NEW.`project_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'incoherent_issue_project_scope');
END;

CREATE TRIGGER `agent_run_project_assignment_current`
BEFORE INSERT ON `agent_run`
WHEN NEW.`status` IN ('assigned', 'launching', 'running')
	AND NEW.`project_assignment_token` != (
		SELECT `project_assignment_token` FROM `issue` WHERE `id` = NEW.`issue_id`
	)
BEGIN
	SELECT RAISE(ABORT, 'stale_project_assignment');
END;
