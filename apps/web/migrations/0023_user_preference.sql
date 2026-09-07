-- Per-user UI preferences: the project focus (Tines/259). One row per user,
-- created lazily on first write; no row means "All projects". Both project
-- pointers null out with the project so a deleted project never strands a
-- focus. See specs/projects/SPEC.md "Project focus".
CREATE TABLE IF NOT EXISTS `user_preference` (
	`user_id` TEXT NOT NULL PRIMARY KEY REFERENCES `user` (`id`) ON DELETE CASCADE,
	`focused_project_id` TEXT REFERENCES `project` (`id`) ON DELETE SET NULL,
	`last_project_id` TEXT REFERENCES `project` (`id`) ON DELETE SET NULL,
	`updated_at` INTEGER NOT NULL
);
