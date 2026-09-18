CREATE TABLE `supervisor_settings_new` (
	`user_id` TEXT NOT NULL PRIMARY KEY REFERENCES `user` (`id`) ON DELETE CASCADE,
	`enabled` INTEGER NOT NULL DEFAULT 1,
	`quota` TEXT NOT NULL,
	`attempt_limit` INTEGER NOT NULL DEFAULT 3,
	`budget` TEXT,
	`pricing` TEXT,
	`github_pat_enc` TEXT,
	`github_pat_hint` TEXT,
	`updated_at` INTEGER NOT NULL
);

INSERT INTO `supervisor_settings_new` (
	`user_id`, `enabled`, `quota`, `attempt_limit`, `budget`, `pricing`,
	`github_pat_enc`, `github_pat_hint`, `updated_at`
)
SELECT
	`user_id`, `enabled`, `quota`, `attempt_limit`, `budget`, `pricing`,
	`github_pat_enc`, `github_pat_hint`, `updated_at`
FROM `supervisor_settings`;

DROP TABLE `supervisor_settings`;
ALTER TABLE `supervisor_settings_new` RENAME TO `supervisor_settings`;
