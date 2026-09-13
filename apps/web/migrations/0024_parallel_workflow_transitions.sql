-- A workflow may offer distinct actions between the same two states. This is
-- useful when one path has artifact requirements and another is an explicit
-- ungated exception. Action names remain unique within their source state.
DROP INDEX `workflow_transition_workflow_id_idx`;

CREATE TABLE `workflow_transition_new` (
	`id` TEXT NOT NULL PRIMARY KEY,
	`workflow_id` TEXT NOT NULL REFERENCES `workflow` (`id`) ON DELETE CASCADE,
	`name` TEXT NOT NULL,
	`from_state_id` TEXT NOT NULL REFERENCES `workflow_state` (`id`),
	`to_state_id` TEXT NOT NULL REFERENCES `workflow_state` (`id`),
	`requirements` TEXT,
	UNIQUE (`workflow_id`, `from_state_id`, `name`)
);

INSERT INTO `workflow_transition_new`
	(`id`, `workflow_id`, `name`, `from_state_id`, `to_state_id`, `requirements`)
SELECT `id`, `workflow_id`, `name`, `from_state_id`, `to_state_id`, `requirements`
FROM `workflow_transition`;

DROP TABLE `workflow_transition`;
ALTER TABLE `workflow_transition_new` RENAME TO `workflow_transition`;
CREATE INDEX `workflow_transition_workflow_id_idx` ON `workflow_transition` (`workflow_id`);
