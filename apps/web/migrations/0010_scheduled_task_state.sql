-- Scheduled tasks: configurable start state for created instances.
--
-- NULL means "the workflow's initial state" (the behavior to date), so the
-- schedule keeps following the workflow if its initial state changes. A set
-- state pins instances to that state. Workflow editing rejects deleting a
-- state a schedule starts in; SET NULL is the race backstop, degrading the
-- schedule to the initial state instead of failing the sweep.

ALTER TABLE `scheduled_task` ADD COLUMN `state_id` TEXT REFERENCES `workflow_state` (`id`) ON DELETE SET NULL;
