-- Tines/752: owner-managed inclusion of library items (account-global or
-- label-only prompt, skill and repo items) into one shared project's guidance.
-- A row is a reference, never a copy: the shared projection re-checks the
-- item's admissibility on every read, so a later rescope leaves it inert.
CREATE TABLE IF NOT EXISTS project_guidance_inclusion (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  context_item_id TEXT NOT NULL REFERENCES context_item(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, context_item_id)
);
CREATE INDEX IF NOT EXISTS project_guidance_inclusion_item ON project_guidance_inclusion(context_item_id);
-- A shared issue whose guidance bundle could not be admitted, and when to retry.
CREATE TABLE IF NOT EXISTS issue_guidance_block (
  issue_id TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
  code TEXT NOT NULL,            -- bundle_too_large | bundle_unavailable
  reason TEXT NOT NULL,          -- item_cap | size_cap | repo_dir_conflict | churn
  retry_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
