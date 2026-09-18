-- Private reporting, host moderation, and retention records for public workflow snapshots.

CREATE TABLE IF NOT EXISTS `workflow_report_case` (
	`snapshot_id` TEXT PRIMARY KEY,
	`version` INTEGER NOT NULL DEFAULT 0 CHECK (`version` >= 0),
	`read_through_version` INTEGER NOT NULL DEFAULT 0 CHECK (`read_through_version` >= 0 AND `read_through_version` <= `version`),
	`resolved_through_version` INTEGER NOT NULL DEFAULT 0 CHECK (`resolved_through_version` >= 0 AND `resolved_through_version` <= `version`),
	`latest_report_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `workflow_report` (
	`id` TEXT PRIMARY KEY,
	`snapshot_id` TEXT NOT NULL REFERENCES `workflow_report_case` (`snapshot_id`) ON DELETE CASCADE,
	`case_version` INTEGER NOT NULL CHECK (`case_version` >= 1),
	`reason` TEXT NOT NULL CHECK (`reason` IN ('harmful_abusive', 'malicious_phishing', 'private_information', 'rights', 'other')),
	`note` TEXT NOT NULL,
	`note_hash` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`resolved_at` INTEGER,
	UNIQUE (`snapshot_id`, `case_version`)
);

CREATE TABLE IF NOT EXISTS `workflow_report_request` (
	`request_token` TEXT PRIMARY KEY,
	`body_hash` TEXT NOT NULL,
	`receipt_id` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`expires_at` INTEGER NOT NULL,
	`attempt_nonce` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `workflow_report_rate_event` (
	`receipt_id` TEXT NOT NULL,
	`subject_kind` TEXT NOT NULL CHECK (`subject_kind` IN ('network', 'account')),
	`subject_token` TEXT NOT NULL,
	`accepted_at` INTEGER NOT NULL,
	`expires_at` INTEGER NOT NULL,
	PRIMARY KEY (`receipt_id`, `subject_kind`)
);

CREATE TABLE IF NOT EXISTS `workflow_moderation_audit` (
	`id` TEXT PRIMARY KEY,
	`request_id` TEXT NOT NULL,
	`request_hash` TEXT NOT NULL,
	`actor_user_id` TEXT NOT NULL,
	`actor_name` TEXT NOT NULL,
	`action` TEXT NOT NULL CHECK (`action` IN ('dismiss', 'disable', 'restore', 'suspend', 'unsuspend')),
	`target_kind` TEXT NOT NULL CHECK (`target_kind` IN ('snapshot', 'publisher')),
	`target_id` TEXT NOT NULL,
	`snapshot_id` TEXT,
	`document_digest` TEXT,
	`bytes_sha256` TEXT,
	`publisher_user_id` TEXT,
	`before_json` TEXT NOT NULL,
	`after_json` TEXT NOT NULL,
	`case_cutoff` INTEGER,
	`reason` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`expires_at` INTEGER NOT NULL,
	UNIQUE (`actor_user_id`, `request_id`)
);

CREATE INDEX IF NOT EXISTS `workflow_report_rate_subject_idx`
	ON `workflow_report_rate_event` (`subject_kind`, `subject_token`, `accepted_at`);
CREATE INDEX IF NOT EXISTS `workflow_report_rate_expiry_idx`
	ON `workflow_report_rate_event` (`expires_at`);
CREATE INDEX IF NOT EXISTS `workflow_report_request_expiry_idx`
	ON `workflow_report_request` (`expires_at`);
CREATE INDEX IF NOT EXISTS `workflow_report_group_idx`
	ON `workflow_report` (`snapshot_id`, `reason`, `note_hash`, `created_at`, `id`);
CREATE INDEX IF NOT EXISTS `workflow_report_case_version_idx`
	ON `workflow_report` (`snapshot_id`, `case_version`);
CREATE INDEX IF NOT EXISTS `workflow_report_resolution_idx`
	ON `workflow_report` (`resolved_at`, `id`);
CREATE INDEX IF NOT EXISTS `workflow_moderation_audit_expiry_idx`
	ON `workflow_moderation_audit` (`expires_at`);
CREATE INDEX IF NOT EXISTS `workflow_moderation_audit_target_idx`
	ON `workflow_moderation_audit` (`target_kind`, `target_id`, `created_at`, `id`);
CREATE INDEX IF NOT EXISTS `workflow_report_case_latest_idx`
	ON `workflow_report_case` (`latest_report_at` DESC, `snapshot_id`);
CREATE INDEX IF NOT EXISTS `workflow_report_case_open_idx`
	ON `workflow_report_case` (`latest_report_at` DESC, `snapshot_id`)
	WHERE `version` > `resolved_through_version`;
CREATE INDEX IF NOT EXISTS `workflow_report_case_unread_idx`
	ON `workflow_report_case` (`latest_report_at` DESC, `snapshot_id`)
	WHERE `version` > `read_through_version`;
