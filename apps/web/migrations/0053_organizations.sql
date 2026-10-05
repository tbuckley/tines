-- Organizations (specs/packs/ORGANIZATIONS_SPEC.md, docs/organizations.md).
--
-- Every user has a personal organization, `org_<user id>`. A NULL
-- `organization_id` on a project, workflow, context item or label means the
-- personal organization of its `user_id`, so rows written by the worker that
-- was deployed before this migration (which knows nothing of organizations)
-- stay correct; readers use COALESCE(organization_id, 'org_' || user_id).
--
-- A shared organization's rows are owned (`user_id`) by its owner, exactly as
-- a shared project's are today; `organization_id` keeps them apart from the
-- owner's personal ones.
CREATE TABLE IF NOT EXISTS `organization` (
	`id` TEXT PRIMARY KEY,
	`name` TEXT NOT NULL,
	`kind` TEXT NOT NULL CHECK (`kind` IN ('personal', 'shared')),
	-- The current owner; for a personal organization, its one user.
	`owner_user_id` TEXT NOT NULL,
	`created_by` TEXT NOT NULL,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	-- Compare-and-swap token for rename, transfer and delete.
	`revision` INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS `organization_personal_uq` ON `organization` (`owner_user_id`)
	WHERE `kind` = 'personal';

CREATE TABLE IF NOT EXISTS `organization_member` (
	`organization_id` TEXT NOT NULL REFERENCES `organization` (`id`) ON DELETE CASCADE,
	`user_id` TEXT NOT NULL,
	`role` TEXT NOT NULL CHECK (`role` IN ('owner', 'manager', 'member')),
	`revision` INTEGER NOT NULL DEFAULT 1,
	`joined_at` INTEGER NOT NULL,
	`revoked_at` INTEGER,
	`updated_at` INTEGER NOT NULL,
	PRIMARY KEY (`organization_id`, `user_id`)
);
CREATE UNIQUE INDEX IF NOT EXISTS `organization_one_owner_uq` ON `organization_member` (`organization_id`)
	WHERE `role` = 'owner' AND `revoked_at` IS NULL;
CREATE INDEX IF NOT EXISTS `organization_member_user_idx` ON `organization_member` (`user_id`);

CREATE TABLE IF NOT EXISTS `organization_invitation` (
	`id` TEXT PRIMARY KEY,
	`organization_id` TEXT NOT NULL REFERENCES `organization` (`id`) ON DELETE CASCADE,
	`email` TEXT NOT NULL,
	`token_hash` TEXT NOT NULL UNIQUE,
	`generation` INTEGER NOT NULL DEFAULT 1,
	`expires_at` INTEGER NOT NULL,
	`created_by_user_id` TEXT NOT NULL,
	`created_by_api_key_id` TEXT,
	`created_at` INTEGER NOT NULL,
	`updated_at` INTEGER NOT NULL,
	`accepted_by_user_id` TEXT,
	`accepted_at` INTEGER,
	`canceled_at` INTEGER,
	`delivery_status` TEXT NOT NULL DEFAULT 'pending' CHECK (`delivery_status` IN ('pending', 'sent', 'failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS `organization_invitation_pending_idx` ON `organization_invitation` (`organization_id`, `email`)
	WHERE `accepted_at` IS NULL AND `canceled_at` IS NULL;

ALTER TABLE `project` ADD COLUMN `organization_id` TEXT;
ALTER TABLE `workflow` ADD COLUMN `organization_id` TEXT;
ALTER TABLE `context_item` ADD COLUMN `organization_id` TEXT;
ALTER TABLE `label` ADD COLUMN `organization_id` TEXT;
CREATE INDEX IF NOT EXISTS `project_organization_idx` ON `project` (`organization_id`);

-- Personal organizations for everyone, and every existing row in its owner's.
INSERT OR IGNORE INTO `organization` (`id`, `name`, `kind`, `owner_user_id`, `created_by`, `created_at`, `updated_at`)
	SELECT 'org_' || `id`, COALESCE(NULLIF(`name`, ''), `email`), 'personal', `id`, `id`,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
	FROM `user`;
INSERT OR IGNORE INTO `organization_member` (`organization_id`, `user_id`, `role`, `revision`, `joined_at`, `updated_at`)
	SELECT 'org_' || `id`, `id`, 'owner', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	FROM `user`;
UPDATE `project` SET `organization_id` = 'org_' || `user_id` WHERE `organization_id` IS NULL;
UPDATE `workflow` SET `organization_id` = 'org_' || `user_id`
	WHERE `organization_id` IS NULL AND `user_id` IS NOT NULL;
UPDATE `context_item` SET `organization_id` = 'org_' || `user_id` WHERE `organization_id` IS NULL;
UPDATE `label` SET `organization_id` = 'org_' || `user_id` WHERE `organization_id` IS NULL;

-- Project and label names are unique within their organization, not across
-- everything their owner owns (a shared organization's rows share its
-- owner's `user_id`).
DROP INDEX IF EXISTS `project_user_name_unique`;
CREATE UNIQUE INDEX IF NOT EXISTS `project_org_name_unique` ON `project` (
	`user_id`, COALESCE(`organization_id`, 'org_' || `user_id`), `name`
);
DROP INDEX IF EXISTS `label_user_name_uq`;
CREATE UNIQUE INDEX IF NOT EXISTS `label_org_name_uq` ON `label` (
	`user_id`, COALESCE(`organization_id`, 'org_' || `user_id`), `name` COLLATE NOCASE
);
