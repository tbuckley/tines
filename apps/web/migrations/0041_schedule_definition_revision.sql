-- Durable fence for scheduled-task definition edits and executions.
ALTER TABLE `scheduled_task` ADD COLUMN `definition_revision` INTEGER NOT NULL DEFAULT 1;
