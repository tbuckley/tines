-- Tines/608: a monotonic revision for the workflow definition. Every committed
-- updateWorkflow batch claims R -> R + 1 as its first statement by writing the
-- absolute value R + 1; if a competing save already moved the row, the trigger
-- raises and the whole D1 batch rolls back. The default is the backfill.
ALTER TABLE `workflow` ADD COLUMN `definition_revision` INTEGER NOT NULL DEFAULT 1;

CREATE TRIGGER `workflow_definition_revision_step`
BEFORE UPDATE OF `definition_revision` ON `workflow`
WHEN NEW.`definition_revision` != OLD.`definition_revision` + 1
BEGIN
	SELECT RAISE(ABORT, 'workflow_definition_conflict');
END;
