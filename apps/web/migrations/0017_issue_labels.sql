-- Issue labels: a flat, user-owned vocabulary plus a join table.
-- Labels are deliberately not scoped to a project — the primary surfaces
-- (/issues, `tines issues list`) are cross-project, so `--label bug` must
-- mean one thing everywhere. A nullable `project_id` can be added later
-- without breaking this shape.
--
-- IF NOT EXISTS throughout: this migration first shipped as
-- 0013_issue_labels.sql (identical content) and was applied to the shared
-- preview database under that name before being renumbered around
-- 0013_run_log_full.sql. Same story as 0008_issue_links.sql.
CREATE TABLE IF NOT EXISTS `label` (
	`id` TEXT PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	-- A palette key (see LABEL_COLORS), never a hex value: the UI maps it
	-- onto the existing --cat custom property so dark mode comes for free.
	`color` TEXT NOT NULL,
	`description` TEXT NOT NULL DEFAULT '',
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `label_user_name_uq` ON `label` (`user_id`, `name` COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS `issue_label` (
	`issue_id` TEXT NOT NULL REFERENCES `issue`(`id`) ON DELETE CASCADE,
	`label_id` TEXT NOT NULL REFERENCES `label`(`id`) ON DELETE CASCADE,
	`created_at` INTEGER NOT NULL,
	PRIMARY KEY (`issue_id`, `label_id`)
);
CREATE INDEX IF NOT EXISTS `issue_label_label_idx` ON `issue_label` (`label_id`);
