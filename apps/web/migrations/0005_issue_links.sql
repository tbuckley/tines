-- Issue links: blocking dependencies and duplicates. See
-- specs/issue_dependencies/SPEC.md.
--
-- Both kinds orient source → target and share one directed graph:
--   blocks:       source blocks target (target is blocked on source)
--   duplicate_of: source is a duplicate of target (target is canonical)
-- Cycle prevention runs in the API across both kinds; the partial unique
-- index enforces at most one canonical issue per duplicate.

CREATE TABLE `issue_link` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`source_issue_id` TEXT NOT NULL REFERENCES `issue` (`id`) ON DELETE CASCADE,
	`target_issue_id` TEXT NOT NULL REFERENCES `issue` (`id`) ON DELETE CASCADE,
	`kind` TEXT NOT NULL CHECK (`kind` IN ('blocks', 'duplicate_of')),
	`created_at` INTEGER NOT NULL,
	CHECK (`source_issue_id` != `target_issue_id`),
	UNIQUE (`source_issue_id`, `target_issue_id`, `kind`)
);
CREATE INDEX `issue_link_target_idx` ON `issue_link` (`target_issue_id`);
-- The UNIQUE triple above already indexes source-led lookups.
CREATE UNIQUE INDEX `issue_link_one_duplicate_idx` ON `issue_link` (`source_issue_id`)
	WHERE `kind` = 'duplicate_of';
