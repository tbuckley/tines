-- Durable, owner-scoped receipts for atomic workflow package installation.

CREATE TABLE IF NOT EXISTS `library_install` (
	`id` TEXT PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
	`actor_key` TEXT NOT NULL,
	`document_digest` TEXT NOT NULL,
	`plan_digest` TEXT NOT NULL,
	`request_digest` TEXT NOT NULL,
	`execution_nonce` TEXT NOT NULL,
	`receipt_json` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	UNIQUE (`user_id`, `id`)
);

CREATE INDEX IF NOT EXISTS `library_install_owner_time_idx`
	ON `library_install` (`user_id`, `created_at` DESC);
