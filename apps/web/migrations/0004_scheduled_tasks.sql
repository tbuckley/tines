-- Scheduled tasks: recurring issue creation. See specs/scheduled_tasks/SPEC.md.
--
-- cron is always populated and is the only thing the sweep evaluates; preset
-- is the round-trippable JSON form for the UI (NULL = raw cron). Timestamps
-- are ms-since-epoch; require_all_closed/enabled are 0/1 integers.

CREATE TABLE `scheduled_task` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`project_id` TEXT NOT NULL REFERENCES `project` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`title_template` TEXT NOT NULL,
	`description_template` TEXT NOT NULL DEFAULT '',
	`workflow_id` TEXT NOT NULL REFERENCES `workflow` (`id`),
	`cron` TEXT NOT NULL,
	`preset` TEXT,
	`timezone` TEXT NOT NULL,
	`require_all_closed` INTEGER NOT NULL DEFAULT 0,
	`enabled` INTEGER NOT NULL DEFAULT 1,
	`next_run_at` INTEGER NOT NULL,
	`last_run_at` INTEGER,
	`run_count` INTEGER NOT NULL DEFAULT 0,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	UNIQUE (`project_id`, `name`)
);
-- The sweep selects on (enabled, next_run_at).
CREATE INDEX `scheduled_task_due_idx` ON `scheduled_task` (`enabled`, `next_run_at`);
CREATE INDEX `scheduled_task_project_id_idx` ON `scheduled_task` (`project_id`);

-- Back-reference from issues created by a schedule; deleting the schedule
-- keeps the issues (the issue.created event payload retains the identity).
ALTER TABLE `issue` ADD COLUMN `scheduled_task_id` TEXT REFERENCES `scheduled_task` (`id`) ON DELETE SET NULL;
CREATE INDEX `issue_scheduled_task_id_idx` ON `issue` (`scheduled_task_id`);
