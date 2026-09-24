CREATE TABLE `project_invitation` (
  `id` TEXT PRIMARY KEY,
  `project_id` TEXT NOT NULL REFERENCES `project` (`id`) ON DELETE CASCADE,
  `email` TEXT NOT NULL,
  `token_hash` TEXT NOT NULL UNIQUE,
  `generation` INTEGER NOT NULL DEFAULT 1 CHECK (`generation` > 0),
  `expires_at` INTEGER NOT NULL,
  `landing_issue_id` TEXT REFERENCES `issue` (`id`) ON DELETE SET NULL,
  `created_by_user_id` TEXT NOT NULL REFERENCES `user` (`id`),
  `created_by_api_key_id` TEXT,
  `created_at` INTEGER NOT NULL,
  `updated_at` INTEGER NOT NULL,
  `accepted_by_user_id` TEXT REFERENCES `user` (`id`) ON DELETE SET NULL,
  `accepted_at` INTEGER,
  `accepted_membership_revision` INTEGER,
  `canceled_at` INTEGER,
  `delivery_status` TEXT NOT NULL DEFAULT 'pending' CHECK (`delivery_status` IN ('pending','sent','failed'))
);
CREATE UNIQUE INDEX `project_invitation_pending_idx` ON `project_invitation` (`project_id`, `email`) WHERE `accepted_at` IS NULL AND `canceled_at` IS NULL;
CREATE INDEX `project_invitation_project_idx` ON `project_invitation` (`project_id`, `created_at`);
ALTER TABLE `project_member` ADD COLUMN `last_request_token` TEXT;
