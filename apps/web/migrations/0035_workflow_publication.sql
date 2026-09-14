-- Revocable hosting records for immutable, text-only workflow package snapshots.

CREATE TABLE IF NOT EXISTS `workflow_publisher_status` (
	`user_id` TEXT PRIMARY KEY REFERENCES `user` (`id`) ON DELETE CASCADE,
	`suspended` INTEGER NOT NULL DEFAULT 0 CHECK (`suspended` IN (0, 1)),
	`status_version` INTEGER NOT NULL DEFAULT 1 CHECK (`status_version` >= 1),
	`decision_reference` TEXT,
	`decision_reason` TEXT
);

CREATE TABLE IF NOT EXISTS `workflow_publication` (
	`id` TEXT PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`actor_key` TEXT NOT NULL,
	`prepare_request_id` TEXT NOT NULL,
	`prepare_request_hash` TEXT NOT NULL,
	`source_workflow_id` TEXT REFERENCES `workflow` (`id`) ON DELETE SET NULL,
	`source_kind` TEXT NOT NULL CHECK (`source_kind` IN ('owned_workflow', 'file')),
	`source_provenance_json` TEXT NOT NULL,
	`document_json` TEXT NOT NULL,
	`document_digest` TEXT NOT NULL,
	`bytes_sha256` TEXT NOT NULL,
	`byte_length` INTEGER NOT NULL CHECK (`byte_length` >= 0 AND `byte_length` <= 1048576),
	`metadata_json` TEXT NOT NULL,
	`review_digest` TEXT NOT NULL,
	`policy_version` INTEGER NOT NULL,
	`created_at` INTEGER NOT NULL,
	`expires_at` INTEGER NOT NULL,
	`snapshot_id` TEXT UNIQUE,
	`published_at` INTEGER,
	`owner_state` TEXT NOT NULL DEFAULT 'candidate' CHECK (`owner_state` IN ('candidate', 'published', 'withdrawn')),
	`host_state` TEXT NOT NULL DEFAULT 'active' CHECK (`host_state` IN ('active', 'removed')),
	`status_version` INTEGER NOT NULL DEFAULT 1 CHECK (`status_version` >= 1),
	`confirmed_at` INTEGER,
	`confirmed_actor_key` TEXT,
	`publication_receipt_json` TEXT,
	`attempt_nonce` TEXT,
	`host_decision_reason` TEXT,
	`host_decision_reference` TEXT,
	UNIQUE (`user_id`, `prepare_request_id`),
	CHECK ((`published_at` IS NULL AND `snapshot_id` IS NULL) OR (`published_at` IS NOT NULL AND `snapshot_id` IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS `workflow_publication_source` (
	`publication_id` TEXT PRIMARY KEY REFERENCES `workflow_publication` (`id`) ON DELETE CASCADE,
	`source_witness_json` TEXT NOT NULL,
	`source_fingerprint` TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS `workflow_publication_event` (
	`id` TEXT PRIMARY KEY,
	`publication_id` TEXT NOT NULL REFERENCES `workflow_publication` (`id`) ON DELETE CASCADE,
	`snapshot_id` TEXT,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`actor_key` TEXT NOT NULL,
	`action` TEXT NOT NULL CHECK (`action` IN ('published', 'withdrawn', 'restored', 'host_removed', 'publisher_suspended', 'publisher_restored')),
	`publication_status_version` INTEGER NOT NULL,
	`publisher_status_version` INTEGER NOT NULL,
	`reason` TEXT,
	`reference` TEXT,
	`created_at` INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS `workflow_publication_snapshot_idx`
	ON `workflow_publication` (`snapshot_id`) WHERE `snapshot_id` IS NOT NULL;
CREATE INDEX IF NOT EXISTS `workflow_publication_owner_time_idx`
	ON `workflow_publication` (`user_id`, `published_at` DESC, `id`);
CREATE INDEX IF NOT EXISTS `workflow_publication_source_time_idx`
	ON `workflow_publication` (`user_id`, `source_workflow_id`, `created_at` DESC, `id`);
CREATE INDEX IF NOT EXISTS `workflow_publication_candidate_expiry_idx`
	ON `workflow_publication` (`expires_at`, `id`) WHERE `published_at` IS NULL;
CREATE INDEX IF NOT EXISTS `workflow_publication_event_snapshot_idx`
	ON `workflow_publication_event` (`snapshot_id`, `created_at`, `id`);

CREATE TRIGGER IF NOT EXISTS `workflow_publication_immutable_snapshot`
BEFORE UPDATE OF `user_id`, `source_workflow_id`, `source_kind`, `source_provenance_json`, `document_json`, `document_digest`, `bytes_sha256`, `byte_length`, `metadata_json`, `review_digest`, `policy_version`, `created_at`, `published_at`, `snapshot_id`, `confirmed_at`, `confirmed_actor_key` ON `workflow_publication`
WHEN OLD.`published_at` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'published workflow snapshot content is immutable');
END;
