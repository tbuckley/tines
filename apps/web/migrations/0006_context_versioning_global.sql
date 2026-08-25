-- Agent-maintained context (specs/context/AGENT_EDITING.md):
--   * version: monotonic write counter for optimistic concurrency (no
--     history is kept — it is a CAS token, not versioning).
--   * The ≥1-scope-dimension CHECK is dropped: an item with no dimensions
--     set is global and matches every issue. SQLite cannot alter a CHECK
--     in place, so the table is rebuilt; the kind CHECK moves to the API
--     layer alongside the other context validation.
--
-- Both context tables are rebuilt: dropping the old parent while
-- context_item_file still referenced it would fire the file table's
-- ON DELETE CASCADE (DROP TABLE performs an implicit DELETE FROM) and
-- destroy skill files. Rebuilding the child against the new parent first
-- means neither DROP has referencing rows. The final RENAMEs rewrite the
-- child's foreign-key target automatically (SQLite ≥ 3.25).

PRAGMA defer_foreign_keys = true;

CREATE TABLE `context_item_new` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`kind` TEXT NOT NULL,
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
	`version` INTEGER NOT NULL DEFAULT 1,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL
);

INSERT INTO `context_item_new` (
	`id`, `user_id`, `kind`, `name`, `description`,
	`project_id`, `workflow_state_id`, `issue_id`,
	`body`, `repo_url`, `repo_branch`, `repo_dir`,
	`position`, `created_at`, `updated_at`
)
SELECT
	`id`, `user_id`, `kind`, `name`, `description`,
	`project_id`, `workflow_state_id`, `issue_id`,
	`body`, `repo_url`, `repo_branch`, `repo_dir`,
	`position`, `created_at`, `updated_at`
FROM `context_item`;

CREATE TABLE `context_item_file_new` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`context_item_id` TEXT NOT NULL REFERENCES `context_item_new` (`id`) ON DELETE CASCADE,
	`path` TEXT NOT NULL,
	`content` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	UNIQUE (`context_item_id`, `path`)
);

INSERT INTO `context_item_file_new`
	(`id`, `context_item_id`, `path`, `content`, `created_at`, `updated_at`)
SELECT `id`, `context_item_id`, `path`, `content`, `created_at`, `updated_at`
FROM `context_item_file`;

DROP TABLE `context_item_file`;
DROP TABLE `context_item`;
ALTER TABLE `context_item_new` RENAME TO `context_item`;
ALTER TABLE `context_item_file_new` RENAME TO `context_item_file`;

CREATE INDEX `context_item_scope_idx`
	ON `context_item` (`user_id`, `project_id`, `workflow_state_id`, `issue_id`);
CREATE INDEX `context_item_file_item_idx` ON `context_item_file` (`context_item_id`);
