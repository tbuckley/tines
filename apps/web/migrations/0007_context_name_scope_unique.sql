-- Name-per-exact-scope uniqueness, enforced at the DB layer. The API's
-- assertNameAvailable is a check-then-insert with no transaction around the
-- read, so two concurrent creates (e.g. both racing to start a journal for
-- the same project ∧ state) could each pass the check and both land. This
-- index makes the loser's insert fail; the API maps that violation back to
-- the `duplicate_context_name` error code the app-level check uses, which
-- the CLI's create-race recovery keys off.
--
-- Scope columns are nullable and SQLite treats NULLs as distinct in unique
-- indexes, so the index is built on COALESCE'd expressions ('' never
-- collides with a real id). Any duplicates that slipped in before this
-- migration are removed first — keeping the earliest-created item of each
-- group, matching the app's invariant that the check enforced one at a time.

DELETE FROM `context_item_file` WHERE `context_item_id` IN (
	SELECT `id` FROM `context_item` AS c WHERE EXISTS (
		SELECT 1 FROM `context_item` AS d
		WHERE d.`user_id` = c.`user_id` AND d.`kind` = c.`kind` AND d.`name` = c.`name`
			AND COALESCE(d.`project_id`, '') = COALESCE(c.`project_id`, '')
			AND COALESCE(d.`workflow_state_id`, '') = COALESCE(c.`workflow_state_id`, '')
			AND COALESCE(d.`issue_id`, '') = COALESCE(c.`issue_id`, '')
			AND (d.`created_at` < c.`created_at` OR (d.`created_at` = c.`created_at` AND d.`id` < c.`id`))
	)
);

DELETE FROM `context_item` WHERE `id` IN (
	SELECT `id` FROM `context_item` AS c WHERE EXISTS (
		SELECT 1 FROM `context_item` AS d
		WHERE d.`user_id` = c.`user_id` AND d.`kind` = c.`kind` AND d.`name` = c.`name`
			AND COALESCE(d.`project_id`, '') = COALESCE(c.`project_id`, '')
			AND COALESCE(d.`workflow_state_id`, '') = COALESCE(c.`workflow_state_id`, '')
			AND COALESCE(d.`issue_id`, '') = COALESCE(c.`issue_id`, '')
			AND (d.`created_at` < c.`created_at` OR (d.`created_at` = c.`created_at` AND d.`id` < c.`id`))
	)
);

CREATE UNIQUE INDEX `context_item_name_scope_uq` ON `context_item` (
	`user_id`, `kind`, `name`,
	COALESCE(`project_id`, ''), COALESCE(`workflow_state_id`, ''), COALESCE(`issue_id`, '')
);
