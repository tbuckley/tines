CREATE TABLE IF NOT EXISTS `user_model_rate` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`user_id` TEXT NOT NULL REFERENCES `user`(`id`) ON DELETE CASCADE,
	`model` TEXT NOT NULL,
	`version` INTEGER NOT NULL,
	`input_rate` TEXT NOT NULL,
	`cache_read_rate` TEXT NOT NULL,
	`cache_write_rate` TEXT,
	`output_rate` TEXT NOT NULL,
	`copied_from` TEXT,
	`created_at` INTEGER NOT NULL,
	`retired_at` INTEGER,
	UNIQUE (`user_id`, `model`, `version`)
);
CREATE INDEX IF NOT EXISTS `user_model_rate_current_idx`
	ON `user_model_rate` (`user_id`, `model`, `retired_at`, `version`);
