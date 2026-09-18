ALTER TABLE runner ADD COLUMN effort_capabilities TEXT;

ALTER TABLE agent_run ADD COLUMN requested_effort TEXT;
ALTER TABLE agent_run ADD COLUMN resolved_effort TEXT;
ALTER TABLE agent_run ADD COLUMN effort_source TEXT;
ALTER TABLE agent_run ADD COLUMN effort_application_status TEXT;
ALTER TABLE agent_run ADD COLUMN effort_application_evidence TEXT;
