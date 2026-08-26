-- Supervisor: runner registry, agent runs, routing rules, and per-user
-- supervisor settings. See specs/supervisor/SPEC.md.
--
-- Secret columns (secret_enc, runner_token_hash, github_pat_enc) are created
-- here but stay unused until the milestones that handle credentials; they
-- never appear in any API response. Timestamps are ms-since-epoch; boolean
-- flags are 0/1 integers, matching the existing tables.

CREATE TABLE `runner` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`type` TEXT NOT NULL CHECK (`type` IN ('claude_managed', 'gemini_managed', 'local')),
	`name` TEXT NOT NULL,
	`status` TEXT NOT NULL DEFAULT 'active' CHECK (`status` IN ('active', 'paused')),
	`max_concurrent` INTEGER NOT NULL DEFAULT 1,
	`max_run_minutes` INTEGER NOT NULL DEFAULT 30,
	`default_tier` TEXT NOT NULL DEFAULT 'balanced',
	`tiers` TEXT,              -- JSON per-tier model overrides
	`budget` TEXT,             -- JSON { daily_usd?, daily_tokens?, max_run_cost_usd?, max_run_tokens? }
	`config` TEXT NOT NULL DEFAULT '{}',  -- JSON non-secret config (harness, hostname, agent ids…)
	`secret_enc` TEXT,         -- encrypted provider API key (managed types)
	`runner_token_hash` TEXT,  -- local type: hashed daemon token
	`last_seen_at` INTEGER,
	`launch_failures` INTEGER NOT NULL DEFAULT 0,
	`backoff_until` INTEGER,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	UNIQUE (`user_id`, `name`)
);

CREATE TABLE `agent_run` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`issue_id` TEXT NOT NULL REFERENCES `issue` (`id`),
	`runner_id` TEXT NOT NULL REFERENCES `runner` (`id`),
	`status` TEXT NOT NULL CHECK (`status` IN ('assigned', 'launching', 'running', 'completed', 'failed', 'timed_out', 'canceled')),
	`tier` TEXT NOT NULL,
	`model` TEXT,              -- resolved at launch; NULL when the harness can't vary it
	`usage` TEXT,              -- JSON { input_tokens, output_tokens, …, cost_usd?, cost_source }
	`state_id_at_start` TEXT NOT NULL,
	`state_id_at_end` TEXT,
	`provider_session_id` TEXT,
	`provider_url` TEXT,
	`api_key_id` TEXT REFERENCES `api_key` (`id`),
	`log` TEXT NOT NULL DEFAULT '',
	`log_bytes_dropped` INTEGER NOT NULL DEFAULT 0,
	`error` TEXT,
	`created_at` INTEGER NOT NULL,
	`started_at` INTEGER,
	`ended_at` INTEGER
);
CREATE INDEX `agent_run_issue_idx` ON `agent_run` (`issue_id`, `created_at`);
-- Quota counts and the claim guards only ever aggregate over active runs.
CREATE INDEX `agent_run_active_idx`
	ON `agent_run` (`user_id`, `runner_id`, `state_id_at_start`)
	WHERE `status` IN ('assigned', 'launching', 'running');
-- The day-window budget tally (a later milestone) scans by user and time.
CREATE INDEX `agent_run_user_time_idx` ON `agent_run` (`user_id`, `created_at`);

-- One rule per exact scope; NULLs are distinct in SQLite unique indexes, so
-- the index is built on COALESCE'd expressions (the migration-0007 idiom).
CREATE TABLE `routing_rule` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`project_id` TEXT REFERENCES `project` (`id`),
	`workflow_state_id` TEXT REFERENCES `workflow_state` (`id`),
	`targets` TEXT NOT NULL,   -- JSON ordered [ { runner_id, tier? } ]
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
CREATE UNIQUE INDEX `routing_rule_scope_uq` ON `routing_rule` (
	`user_id`, COALESCE(`project_id`, ''), COALESCE(`workflow_state_id`, '')
);

CREATE TABLE `supervisor_settings` (
	`user_id` TEXT NOT NULL PRIMARY KEY REFERENCES `user` (`id`) ON DELETE CASCADE,
	`enabled` INTEGER NOT NULL DEFAULT 0,  -- the kill switch; off for new users
	`quota` TEXT NOT NULL,     -- JSON typed quota policy ({ "type": "global_cap", … })
	`attempt_limit` INTEGER NOT NULL DEFAULT 3,
	`budget` TEXT,             -- JSON { daily_usd?, daily_tokens?, timezone }
	`pricing` TEXT,            -- JSON per-model-id price overrides
	`github_pat_enc` TEXT,
	`github_pat_hint` TEXT,
	`updated_at` INTEGER NOT NULL
);

-- Pins and the attempt budget live on the issue.
ALTER TABLE `issue` ADD COLUMN `pinned_runner_id` TEXT REFERENCES `runner` (`id`);
ALTER TABLE `issue` ADD COLUMN `pinned_tier` TEXT;
ALTER TABLE `issue` ADD COLUMN `attempt_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `issue` ADD COLUMN `needs_attention` INTEGER NOT NULL DEFAULT 0;

-- Run keys are api_key rows bound to a run, with an expiry; both NULL for
-- ordinary named keys.
ALTER TABLE `api_key` ADD COLUMN `agent_run_id` TEXT REFERENCES `agent_run` (`id`);
ALTER TABLE `api_key` ADD COLUMN `expires_at` INTEGER;
