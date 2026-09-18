CREATE INDEX IF NOT EXISTS agent_run_user_issue_created_idx
ON agent_run(user_id, issue_id, created_at, id);
