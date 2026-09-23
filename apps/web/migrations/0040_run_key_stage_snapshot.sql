-- Run keys keep structured mint-time stage metadata alongside their human-readable
-- name so narrow surfaces can omit the runner without parsing ambiguous display text.
ALTER TABLE api_key ADD COLUMN run_workflow_name TEXT;
ALTER TABLE api_key ADD COLUMN run_state_name TEXT;
