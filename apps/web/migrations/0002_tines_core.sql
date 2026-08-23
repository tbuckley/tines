-- Tines phase-one core schema: projects, workflows, issues, comments,
-- events, API keys. See specs/phase_01/SPEC.md.
--
-- All ids are opaque strings; timestamps are ms-since-epoch integers.

CREATE TABLE `project` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`description` TEXT NOT NULL DEFAULT '',
	`default_workflow_id` TEXT REFERENCES `workflow` (`id`),
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
CREATE INDEX `project_user_id_idx` ON `project` (`user_id`);

-- user_id NULL = system workflow (the standard workflow, seeded below).
CREATE TABLE `workflow` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT REFERENCES `user` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`description` TEXT NOT NULL DEFAULT '',
	`initial_state_id` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);
CREATE INDEX `workflow_user_id_idx` ON `workflow` (`user_id`);

-- category: 'backlog' | 'active' | 'awaiting_human' | 'done'
CREATE TABLE `workflow_state` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`workflow_id` TEXT NOT NULL REFERENCES `workflow` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`category` TEXT NOT NULL CHECK (`category` IN ('backlog', 'active', 'awaiting_human', 'done')),
	`position` INTEGER NOT NULL,
	`created_at` INTEGER NOT NULL
);
CREATE INDEX `workflow_state_workflow_id_idx` ON `workflow_state` (`workflow_id`);

-- name: the action this transition represents ("approve", "send back"),
-- unique among transitions leaving the same state.
CREATE TABLE `workflow_transition` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`workflow_id` TEXT NOT NULL REFERENCES `workflow` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`from_state_id` TEXT NOT NULL REFERENCES `workflow_state` (`id`),
	`to_state_id` TEXT NOT NULL REFERENCES `workflow_state` (`id`),
	UNIQUE (`workflow_id`, `from_state_id`, `to_state_id`),
	UNIQUE (`workflow_id`, `from_state_id`, `name`)
);
CREATE INDEX `workflow_transition_workflow_id_idx` ON `workflow_transition` (`workflow_id`);

CREATE TABLE `issue` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`project_id` TEXT NOT NULL REFERENCES `project` (`id`),
	`number` INTEGER NOT NULL,
	`title` TEXT NOT NULL,
	`description` TEXT NOT NULL DEFAULT '',
	`workflow_id` TEXT NOT NULL REFERENCES `workflow` (`id`),
	`state_id` TEXT NOT NULL REFERENCES `workflow_state` (`id`),
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	UNIQUE (`project_id`, `number`)
);
CREATE INDEX `issue_project_id_idx` ON `issue` (`project_id`);
CREATE INDEX `issue_workflow_id_idx` ON `issue` (`workflow_id`);
CREATE INDEX `issue_state_id_idx` ON `issue` (`state_id`);

CREATE TABLE `comment` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`issue_id` TEXT NOT NULL REFERENCES `issue` (`id`),
	`body` TEXT NOT NULL,
	`actor_user_id` TEXT NOT NULL REFERENCES `user` (`id`),
	`actor_api_key_id` TEXT REFERENCES `api_key` (`id`),
	`created_at` INTEGER NOT NULL
);
CREATE INDEX `comment_issue_id_idx` ON `comment` (`issue_id`);

-- Global, append-only event stream per user. user_id is the stream owner;
-- actor fields say who did it. type is an open string; payload is JSON.
CREATE TABLE `event` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`type` TEXT NOT NULL,
	`actor_user_id` TEXT NOT NULL REFERENCES `user` (`id`),
	`actor_api_key_id` TEXT REFERENCES `api_key` (`id`),
	`issue_id` TEXT REFERENCES `issue` (`id`) ON DELETE SET NULL,
	`project_id` TEXT REFERENCES `project` (`id`) ON DELETE SET NULL,
	`payload` TEXT NOT NULL DEFAULT '{}',
	`created_at` INTEGER NOT NULL
);
CREATE INDEX `event_user_created_idx` ON `event` (`user_id`, `created_at` DESC);
CREATE INDEX `event_issue_id_idx` ON `event` (`issue_id`);
CREATE INDEX `event_project_id_idx` ON `event` (`project_id`);

CREATE TABLE `api_key` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`key_hash` TEXT NOT NULL UNIQUE,
	`key_prefix` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`last_used_at` INTEGER,
	`revoked_at` INTEGER
);
CREATE INDEX `api_key_user_id_idx` ON `api_key` (`user_id`);

-- Seed the standard workflow (system-owned, read-only in the app layer).
INSERT INTO `workflow` (`id`, `user_id`, `name`, `description`, `initial_state_id`, `created_at`, `updated_at`)
VALUES (
	'wf_standard', NULL, 'Standard',
	'The built-in workflow: Open → Human Review → Closed.',
	'wfs_std_open',
	CAST(strftime('%s', 'now') AS INTEGER) * 1000,
	CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

INSERT INTO `workflow_state` (`id`, `workflow_id`, `name`, `category`, `position`, `created_at`)
VALUES
	('wfs_std_open', 'wf_standard', 'Open', 'active', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
	('wfs_std_review', 'wf_standard', 'Human Review', 'awaiting_human', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
	('wfs_std_closed', 'wf_standard', 'Closed', 'done', 2, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO `workflow_transition` (`id`, `workflow_id`, `name`, `from_state_id`, `to_state_id`)
VALUES
	('wft_std_open_review', 'wf_standard', 'Submit for review', 'wfs_std_open', 'wfs_std_review'),
	('wft_std_review_open', 'wf_standard', 'Send back', 'wfs_std_review', 'wfs_std_open'),
	('wft_std_review_closed', 'wf_standard', 'Approve', 'wfs_std_review', 'wfs_std_closed'),
	('wft_std_open_closed', 'wf_standard', 'Abandon', 'wfs_std_open', 'wfs_std_closed');
