-- Browser-session owner permission and guarded run admission (Tines/669 S1).
ALTER TABLE `project` ADD COLUMN `shared_at` INTEGER;
ALTER TABLE `project` ADD COLUMN `sharing_revision` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `workflow` ADD COLUMN `decision_revision` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `issue` ADD COLUMN `decision_revision` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `issue` ADD COLUMN `consent_epoch` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `issue` ADD COLUMN `agent_hold` INTEGER NOT NULL DEFAULT 0 CHECK (`agent_hold` IN (0, 1));
ALTER TABLE `issue` ADD COLUMN `hold_revision` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `issue` ADD COLUMN `last_decision_token` TEXT;

ALTER TABLE `agent_run` ADD COLUMN `admitted_project_owner_id` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `admitted_project_id` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `admitted_daemon_instance_id` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `admitted_at` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `admission_evidence` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `claim_owner_id` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `claim_sharing_revision` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `claim_consent_epoch` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `claim_consent_revision` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `cancel_requested_at` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `cancel_requested_by_user_id` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `cancel_reason` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `cancellation_token` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `assignment_release_token` TEXT;

CREATE TABLE `issue_personal_choice` (
	`issue_id` TEXT NOT NULL REFERENCES `issue` (`id`) ON DELETE CASCADE,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`value` TEXT NOT NULL CHECK (`value` IN ('on', 'off', 'unset')),
	`revision` INTEGER NOT NULL DEFAULT 1 CHECK (`revision` > 0),
	`issue_epoch` INTEGER NOT NULL DEFAULT 0,
	`membership_revision` INTEGER NOT NULL DEFAULT 0,
	`source_kind` TEXT CHECK (`source_kind` IN ('explicit_issue', 'schedule')),
	`source_schedule_id` TEXT,
	`source_grant_revision` INTEGER,
	`source_permission_epoch` INTEGER,
	`last_request_token` TEXT,
	`updated_at` INTEGER NOT NULL,
	PRIMARY KEY (`issue_id`, `user_id`)
);
CREATE INDEX `issue_personal_choice_user_idx` ON `issue_personal_choice` (`user_id`, `issue_id`);
CREATE INDEX `issue_personal_choice_source_idx` ON `issue_personal_choice` (`source_schedule_id`, `user_id`);

CREATE TABLE `personal_disclosure` (
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`version` INTEGER NOT NULL CHECK (`version` > 0),
	`acknowledged_at` INTEGER NOT NULL,
	PRIMARY KEY (`user_id`, `version`)
);

CREATE INDEX `agent_run_pending_cancel_idx` ON `agent_run` (`cancel_requested_at`, `status`)
	WHERE `cancel_requested_at` IS NOT NULL;
