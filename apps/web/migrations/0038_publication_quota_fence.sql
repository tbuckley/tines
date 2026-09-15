-- Serialize publication quota admission per publisher. The application advances
-- this fence in the same D1 batch as the guarded snapshot commit, so concurrent
-- candidates cannot both admit themselves from one stale rolling-window count.
CREATE TABLE IF NOT EXISTS `workflow_publication_quota_fence` (
	`user_id` TEXT PRIMARY KEY,
	`version` INTEGER NOT NULL CHECK (`version` >= 1),
	`attempt_nonce` TEXT NOT NULL
);
