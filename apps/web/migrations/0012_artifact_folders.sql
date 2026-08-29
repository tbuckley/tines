-- Folder artifacts (specs/artifacts/SPEC.md): a folder version is one
-- immutable multi-file snapshot — the artifact_version row plus one child
-- row per file, all sharing the version's single created_at (freshness is
-- set-granular by construction). File bytes live in R2 under
-- art/{user}/{item}/{version}/{file}; a reaffirming version's rows reference
-- the reaffirmed version's objects (safe: deletion is whole-artifact only,
-- a prefix delete on the item).

CREATE TABLE `artifact_version_file` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`artifact_version_id` TEXT NOT NULL REFERENCES `artifact_version` (`id`) ON DELETE CASCADE,
	`path` TEXT NOT NULL,
	`content_type` TEXT NOT NULL,
	`size_bytes` INTEGER NOT NULL,
	`r2_key` TEXT NOT NULL,
	UNIQUE (`artifact_version_id`, `path`)
);
CREATE INDEX `artifact_version_file_version_idx`
	ON `artifact_version_file` (`artifact_version_id`);
