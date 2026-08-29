-- Issue artifacts (specs/artifacts/SPEC.md): a fourth context kind with an
-- immutable per-artifact version history, plus the first transition-gating
-- mechanism (requirements on workflow transitions, freshness by timestamp).
--
--   * context_item.config: JSON kind-specific config (the column the context
--     spec reserved); artifacts store {"artifact_type": "file" | …}.
--   * workflow_transition.requirements: JSON array of artifact requirements;
--     NULL = none. Re-created wholesale with the transition rows on every
--     workflow PATCH, so nothing keys on the transition id.
--   * issue.state_entered_at: stamped `now` by every path that changes
--     state_id; freshness compares artifact version timestamps against it.
--     Backfilled with created_at — deliberately permissive, so pre-existing
--     attachments don't all wake up stale.
--   * artifact_version: one immutable row per attached version, numbered
--     from 1. File bytes live in R2 (r2_key); text inline; link/pr are
--     reference-only. A reaffirming version reuses the source version's
--     payload (same r2_key) with reaffirmed_from pointing at it.

ALTER TABLE `context_item` ADD COLUMN `config` TEXT;
ALTER TABLE `workflow_transition` ADD COLUMN `requirements` TEXT;
ALTER TABLE `issue` ADD COLUMN `state_entered_at` INTEGER;

UPDATE `issue` SET `state_entered_at` = `created_at` WHERE `state_entered_at` IS NULL;

CREATE TABLE `artifact_version` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`context_item_id` TEXT NOT NULL REFERENCES `context_item` (`id`) ON DELETE CASCADE,
	`version` INTEGER NOT NULL,
	`filename` TEXT,
	`content_type` TEXT,
	`size_bytes` INTEGER,
	`r2_key` TEXT,
	`content` TEXT,
	`url` TEXT,
	`title` TEXT,
	`pr_repo_url` TEXT,
	`pr_number` INTEGER,
	`reaffirmed_from` INTEGER,
	`actor_user_id` TEXT,
	`actor_api_key_id` TEXT,
	`created_at` INTEGER NOT NULL,
	UNIQUE (`context_item_id`, `version`)
);
-- Current-version reads: newest version per artifact.
CREATE INDEX `artifact_version_item_idx` ON `artifact_version` (`context_item_id`, `version` DESC);
