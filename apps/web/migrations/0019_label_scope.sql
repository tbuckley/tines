-- Label as a fourth scope dimension (Tines/168).
--
-- Both `specs/context/SPEC.md` and `specs/supervisor/SPEC.md` planned for this
-- shape: "one more nullable column with the same AND semantics". A label is
-- the first scope dimension whose target holds a *set* of values (an issue
-- carries many labels), which the matching query and the tie-break rules
-- handle — the schema itself is exactly the planned column.
--
-- The two scope-uniqueness guards are SQL unique indexes (0007 and 0009), not
-- API-layer checks, so both have to be rebuilt to include the new dimension:
-- without that, `skill "x" @ project P ∧ label docs` and `skill "x" @ project P`
-- would collide even though they are different scopes.

ALTER TABLE `context_item` ADD COLUMN `label_id` TEXT REFERENCES `label` (`id`);
ALTER TABLE `routing_rule` ADD COLUMN `label_id` TEXT REFERENCES `label` (`id`);

CREATE INDEX IF NOT EXISTS `context_item_label_idx` ON `context_item` (`label_id`);
CREATE INDEX IF NOT EXISTS `routing_rule_label_idx` ON `routing_rule` (`label_id`);

DROP INDEX IF EXISTS `context_item_name_scope_uq`;
CREATE UNIQUE INDEX `context_item_name_scope_uq` ON `context_item` (
	`user_id`, `kind`, `name`,
	COALESCE(`project_id`, ''), COALESCE(`workflow_state_id`, ''), COALESCE(`issue_id`, ''),
	COALESCE(`label_id`, '')
);

DROP INDEX IF EXISTS `routing_rule_scope_uq`;
CREATE UNIQUE INDEX `routing_rule_scope_uq` ON `routing_rule` (
	`user_id`, COALESCE(`project_id`, ''), COALESCE(`workflow_state_id`, ''), COALESCE(`label_id`, '')
);
