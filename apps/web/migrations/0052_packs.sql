-- Packs MVP (specs/packs/MVP_SPEC.md, docs/packs.md).
--
-- A pack belongs to one project. `project_id` is nullable, and `organization_id`
-- exists from the start, so organization-level packs can arrive without
-- rebuilding this table: exactly one of the two is set.
CREATE TABLE IF NOT EXISTS pack (
	id TEXT PRIMARY KEY,
	project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
	organization_id TEXT,
	-- `pack.yaml` id: identity across versions and projects.
	pack_key TEXT NOT NULL,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL CHECK (kind IN ('authored', 'installed')),
	-- Installed: the installed version. Authored: the last exported version (NULL before the first export).
	version INTEGER,
	-- Digest of the installed version's files, or of the last export.
	digest TEXT,
	source_kind TEXT CHECK (source_kind IN ('file', 'project')),
	-- `pack.id` of the pack this one was installed from, for source_kind 'project'.
	source_pack_id TEXT,
	-- JSON {"id","version"} set by Detach; informational.
	derived_from TEXT,
	-- The project's pack order; later packs win a name.
	position INTEGER NOT NULL,
	-- JSON object of input declarations, in declaration order.
	inputs TEXT NOT NULL DEFAULT '{}',
	readme TEXT,
	changelog TEXT,
	-- JSON `migrations.yaml`.
	migrations TEXT NOT NULL DEFAULT '{}',
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	-- Compare-and-swap token for replace, detach, remove and input edits.
	revision INTEGER NOT NULL DEFAULT 1,
	CHECK ((project_id IS NULL) <> (organization_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS pack_project_key ON pack(project_id, pack_key)
	WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pack_source ON pack(source_pack_id) WHERE source_pack_id IS NOT NULL;

-- The project's value for one input. Secret inputs never have a row here.
CREATE TABLE IF NOT EXISTS pack_input_value (
	pack_id TEXT NOT NULL REFERENCES pack(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	text_value TEXT,
	repo_url TEXT,
	repo_branch TEXT,
	-- A workflow input: the bound workflow (a deleted workflow leaves it unbound) and optional start state.
	workflow_id TEXT,
	state_id TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (pack_id, name)
);

-- One contributor's own value for one secret. No one reads another's value.
-- Organizations add env-item secrets to this table (`context_item_id`).
CREATE TABLE IF NOT EXISTS contributor_secret (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	pack_id TEXT REFERENCES pack(id) ON DELETE CASCADE,
	input_name TEXT,
	value_enc TEXT NOT NULL,
	hint TEXT,
	updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contributor_secret_pack_input
	ON contributor_secret(user_id, pack_id, input_name) WHERE pack_id IS NOT NULL;

-- A pack's suggested schedules.
CREATE TABLE IF NOT EXISTS pack_schedule (
	id TEXT PRIMARY KEY,
	pack_id TEXT NOT NULL REFERENCES pack(id) ON DELETE CASCADE,
	-- The file stem; identifies the suggestion across versions.
	schedule_key TEXT NOT NULL,
	name TEXT NOT NULL,
	workflow_key TEXT NOT NULL,
	start_key TEXT,
	-- JSON PackRecurrence.
	recurrence TEXT NOT NULL,
	only_when_previous_closed INTEGER NOT NULL DEFAULT 0,
	title TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	position INTEGER NOT NULL,
	UNIQUE (pack_id, schedule_key)
);

-- The files of the installed version (or the last export), for the replace
-- diff and for re-exporting an installed pack byte for byte. One row per
-- file: D1 caps a single value well below the 5 MiB archive limit.
CREATE TABLE IF NOT EXISTS pack_snapshot_file (
	pack_id TEXT NOT NULL REFERENCES pack(id) ON DELETE CASCADE,
	path TEXT NOT NULL,
	-- Base64 of the file's bytes.
	content_b64 TEXT NOT NULL,
	sha256 TEXT NOT NULL,
	PRIMARY KEY (pack_id, path)
);

-- Proof that one reviewed install or replace committed (the confirmation is
-- bound to the reviewed digest).
CREATE TABLE IF NOT EXISTS pack_receipt (
	id TEXT PRIMARY KEY,
	pack_id TEXT NOT NULL,
	project_id TEXT,
	action TEXT NOT NULL CHECK (action IN ('install', 'replace')),
	digest TEXT NOT NULL,
	version INTEGER,
	actor_user_id TEXT NOT NULL,
	receipt_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

-- Workflows and states that come from a pack. `key` is the folder name;
-- Replace matches by key so ids, and everything pointing at them, survive.
ALTER TABLE workflow ADD COLUMN pack_id TEXT;
ALTER TABLE workflow ADD COLUMN key TEXT;
CREATE INDEX IF NOT EXISTS workflow_pack ON workflow(pack_id) WHERE pack_id IS NOT NULL;
ALTER TABLE workflow_state ADD COLUMN key TEXT;

-- Pack context items. `reach` says which issues the item applies to: the
-- whole project, any of the pack's workflows, one workflow (`workflow_id`),
-- or one state (`workflow_state_id`). `input_refs` lists the inputs the item
-- reads (placeholders and `{ input: }` values), so dispatch can refuse a run
-- whose context needs a value nobody supplied. `config` carries
-- `{"input": "<name>"}` for env and repo items bound to an input.
ALTER TABLE context_item ADD COLUMN pack_id TEXT;
ALTER TABLE context_item ADD COLUMN reach TEXT
	CHECK (reach IS NULL OR reach IN ('project', 'pack', 'workflow', 'state'));
ALTER TABLE context_item ADD COLUMN workflow_id TEXT;
ALTER TABLE context_item ADD COLUMN input_refs TEXT;
CREATE INDEX IF NOT EXISTS context_item_pack ON context_item(pack_id) WHERE pack_id IS NOT NULL;
-- A name is unique per exact scope, as before, and now also per pack and
-- reach: two packs (or a pack and the project) may each have a project-wide
-- `conventions` prompt; the later layer wins it at read time.
DROP INDEX IF EXISTS `context_item_name_scope_uq`;
CREATE UNIQUE INDEX `context_item_name_scope_uq` ON `context_item` (
	`user_id`, `kind`, `name`,
	COALESCE(`project_id`, ''), COALESCE(`workflow_state_id`, ''), COALESCE(`issue_id`, ''),
	COALESCE(`label_id`, ''), COALESCE(`pack_id`, ''), COALESCE(`reach`, ''),
	COALESCE(`workflow_id`, '')
);

-- A project schedule created from a pack's suggestion; for display only.
ALTER TABLE scheduled_task ADD COLUMN pack_schedule_id TEXT;
