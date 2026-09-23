ALTER TABLE comment ADD COLUMN author_run_id TEXT;
ALTER TABLE comment ADD COLUMN author_run_name TEXT;
ALTER TABLE comment ADD COLUMN editor_user_id TEXT;
ALTER TABLE comment ADD COLUMN editor_api_key_id TEXT;
ALTER TABLE comment ADD COLUMN edited_at INTEGER;
ALTER TABLE comment ADD COLUMN last_edit_token TEXT;

UPDATE comment SET author_run_id = (
  SELECT agent_run_id FROM api_key WHERE id = comment.actor_api_key_id
) WHERE actor_api_key_id IS NOT NULL;

UPDATE comment SET author_run_name = (
  SELECT r.name FROM agent_run ar JOIN runner r ON r.id = ar.runner_id
  WHERE ar.id = comment.author_run_id
) WHERE author_run_id IS NOT NULL;
