-- Future-instance permission is independent of execution definition revision.
ALTER TABLE `scheduled_task` ADD COLUMN `permission_epoch` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `scheduled_task` ADD COLUMN `last_update_token` TEXT;

-- Inert until the invitation/activation slice; schedule grants can already
-- prove current membership without trusting an event actor.
CREATE TABLE `project_member` (
  `project_id` TEXT NOT NULL REFERENCES `project` (`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
  `revision` INTEGER NOT NULL DEFAULT 1 CHECK (`revision` > 0),
  `joined_at` INTEGER NOT NULL,
  `revoked_at` INTEGER,
  `updated_at` INTEGER NOT NULL,
  PRIMARY KEY (`project_id`, `user_id`)
);
CREATE INDEX `project_member_user_idx` ON `project_member` (`user_id`, `revoked_at`, `project_id`);

CREATE TABLE `schedule_personal_choice` (
  `schedule_id` TEXT NOT NULL REFERENCES `scheduled_task` (`id`) ON DELETE CASCADE,
  `user_id` TEXT NOT NULL REFERENCES `user` (`id`) ON DELETE CASCADE,
  `value` TEXT NOT NULL CHECK (`value` IN ('on', 'off')),
  `revision` INTEGER NOT NULL CHECK (`revision` > 0),
  `permission_epoch` INTEGER NOT NULL,
  `membership_revision` INTEGER NOT NULL DEFAULT 0,
  `last_request_token` TEXT,
  `updated_at` INTEGER NOT NULL,
  PRIMARY KEY (`schedule_id`, `user_id`)
);
CREATE INDEX `schedule_personal_choice_user_idx` ON `schedule_personal_choice` (`user_id`, `schedule_id`);

-- Text provenance survives schedule deletion and cannot itself authorize a run.
CREATE TABLE `issue_schedule_origin` (
  `issue_id` TEXT PRIMARY KEY REFERENCES `issue` (`id`) ON DELETE CASCADE,
  `schedule_id` TEXT NOT NULL,
  `schedule_name` TEXT NOT NULL,
  `permission_epoch` INTEGER NOT NULL,
  `definition_revision` INTEGER NOT NULL,
  `snapshot` TEXT NOT NULL CHECK (json_valid(`snapshot`)),
  `created_at` INTEGER NOT NULL
);
CREATE INDEX `issue_schedule_origin_schedule_idx` ON `issue_schedule_origin` (`schedule_id`);
