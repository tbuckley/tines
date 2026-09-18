-- A workflow state may inherit context from another state (Tines/238):
-- effective context for an issue includes items scoped to the state's
-- ancestors, stitched root → leaf before the state's own layer. No new scope
-- dimension; the pointer lives on the state. No ON DELETE action on purpose
-- (same posture as issue.state_id): the API clears children before deleting a
-- base, and a racing delete fails the batch rather than silently changing
-- another workflow's prompts. The index serves the delete guard's
-- "who inherits from these states" lookup.
ALTER TABLE `workflow_state` ADD COLUMN `inherits_from_state_id` TEXT REFERENCES `workflow_state` (`id`);
CREATE INDEX IF NOT EXISTS `workflow_state_inherits_from_idx` ON `workflow_state` (`inherits_from_state_id`);
