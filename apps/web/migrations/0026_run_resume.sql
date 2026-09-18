-- Opt-in continuation of an awaiting run. Resource rows are internal: they
-- fence reuse against cleanup while public run rows retain only lineage and
-- policy/audit metadata.

ALTER TABLE `runner` ADD COLUMN `resume_enabled` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `runner` ADD COLUMN `resume_window_hours` INTEGER NOT NULL DEFAULT 48;
ALTER TABLE `runner` ADD COLUMN `resume_max_turns` INTEGER NOT NULL DEFAULT 25;
ALTER TABLE `runner` ADD COLUMN `resume_max_tokens` INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE `runner` ADD COLUMN `resume_max_cost_usd` REAL NOT NULL DEFAULT 2;
ALTER TABLE `runner` ADD COLUMN `resume_config_revision` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `supervisor_settings` ADD COLUMN `source_credentials_revision` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `agent_run` ADD COLUMN `turn_count` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `conversation_turn_count` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `workspace_path` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `resume_fingerprint` TEXT;
ALTER TABLE `agent_run` ADD COLUMN `resumed_from_run_id` TEXT REFERENCES `agent_run` (`id`) ON DELETE SET NULL;
ALTER TABLE `agent_run` ADD COLUMN `resume_expires_at` INTEGER;
ALTER TABLE `agent_run` ADD COLUMN `resume_fallback_reason` TEXT CHECK (`resume_fallback_reason` IN (
	'expired', 'long_context', 'incompatible', 'unavailable', 'unsupported', 'provider_rejected'
));

CREATE TABLE `run_resource` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`runner_id` TEXT REFERENCES `runner` (`id`) ON DELETE SET NULL,
	`issue_id` TEXT REFERENCES `issue` (`id`) ON DELETE SET NULL,
	`kind` TEXT NOT NULL CHECK (`kind` IN ('local_claude', 'claude_managed')),
	`owner_run_id` TEXT REFERENCES `agent_run` (`id`) ON DELETE SET NULL,
	`state` TEXT NOT NULL CHECK (`state` IN (
		'active', 'pending_retention', 'available', 'claimed', 'disposing', 'disposed'
	)),
	`claim_run_id` TEXT REFERENCES `agent_run` (`id`) ON DELETE SET NULL,
	`claim_token` TEXT,
	`claim_started_at` INTEGER,
	`transfer_phase` TEXT CHECK (`transfer_phase` IN ('preparing', 'sending', 'accepted')),
	`expires_at` INTEGER,
	`available_seen_at` INTEGER,
	`provider_session_id` TEXT,
	`vault_id` TEXT,
	`credential_id` TEXT,
	`workspace_path` TEXT,
	`resume_fingerprint` TEXT NOT NULL,
	`transfer_data` TEXT,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);

CREATE UNIQUE INDEX `run_resource_runner_session_uq`
	ON `run_resource` (`runner_id`, `provider_session_id`)
	WHERE `provider_session_id` IS NOT NULL;
CREATE INDEX `run_resource_runner_state_expiry_idx`
	ON `run_resource` (`runner_id`, `state`, `expires_at`);
CREATE INDEX `run_resource_issue_owner_idx`
	ON `run_resource` (`issue_id`, `owner_run_id`);
