-- What a run launched in this state may touch beyond its own issue
-- (Tines/737): 'issue' (default), 'project' (any issue and journal in the
-- run's project) or 'workspace' (plus creating and editing shared context,
-- workflows and labels). Only the workflow's owner sets it, from a browser
-- session; no API key can.
ALTER TABLE workflow_state ADD COLUMN run_scope TEXT NOT NULL DEFAULT 'issue'
	CHECK (run_scope IN ('issue', 'project', 'workspace'));
