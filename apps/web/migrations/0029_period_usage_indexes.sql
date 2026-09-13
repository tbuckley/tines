CREATE INDEX IF NOT EXISTS agent_run_user_ended_idx
ON agent_run(user_id, ended_at DESC, id DESC)
WHERE ended_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_run_user_pending_idx
ON agent_run(user_id, created_at DESC, id DESC)
WHERE ended_at IS NULL;
