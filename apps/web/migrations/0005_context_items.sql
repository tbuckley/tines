-- Context items: typed context (prompt / skill / repo) scoped to an
-- intersection of project / workflow state / issue. See specs/context/SPEC.md.
--
-- Kind-specific payloads live as nullable columns (body for prompts, repo_*
-- for repos) plus the child file table for skills. Scope is nullable columns
-- with AND semantics; at least one dimension must be set. Name-uniqueness per
-- (kind, exact scope) is enforced in the API layer only — a partial-NULL
-- unique index can't express it in SQLite.

CREATE TABLE `context_item` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`kind` TEXT NOT NULL CHECK (`kind` IN ('prompt', 'skill', 'repo')),
	`name` TEXT NOT NULL,
	`description` TEXT NOT NULL DEFAULT '',
	`project_id` TEXT REFERENCES `project` (`id`),
	`workflow_state_id` TEXT REFERENCES `workflow_state` (`id`),
	`issue_id` TEXT REFERENCES `issue` (`id`),
	`body` TEXT,
	`repo_url` TEXT,
	`repo_branch` TEXT,
	`repo_dir` TEXT,
	`position` INTEGER NOT NULL DEFAULT 0,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	CHECK (`project_id` IS NOT NULL OR `workflow_state_id` IS NOT NULL OR `issue_id` IS NOT NULL)
);
-- Non-unique: supports the matching and listing queries.
CREATE INDEX `context_item_scope_idx`
	ON `context_item` (`user_id`, `project_id`, `workflow_state_id`, `issue_id`);

CREATE TABLE `context_item_file` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`context_item_id` TEXT NOT NULL REFERENCES `context_item` (`id`) ON DELETE CASCADE,
	`path` TEXT NOT NULL,
	`content` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	UNIQUE (`context_item_id`, `path`)
);
CREATE INDEX `context_item_file_item_idx` ON `context_item_file` (`context_item_id`);
