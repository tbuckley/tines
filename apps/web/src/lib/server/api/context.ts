import {
	actorLabel,
	AGENT_GUIDELINES_BODY,
	AGENT_GUIDELINES_DESCRIPTION,
	AGENT_GUIDELINES_NAME,
	CONTEXT_KINDS,
	JOURNAL_NAME,
	PROMPT_MAX_BYTES,
	repoDirFromUrl,
	SKILL_MAX_FILES,
	SKILL_MAX_TOTAL_BYTES,
	SKILL_NAME_PATTERN,
	type AppendContextRequest,
	type Artifact,
	type ArtifactRequirementCheck,
	type ContextFile,
	type ContextItem,
	type ContextKind,
	type ContextScope,
	type ContextSummary,
	type CreateContextItemRequest,
	type DeletedContextItem,
	type EffectiveContext,
	type EffectivePromptPart,
	type EffectiveRepo,
	type EffectiveSkill,
	type IssueDetail,
	type OverriddenContextItem,
	type RepoDirConflict,
	type UpdateContextItemRequest
} from '@tines/shared';
import type { D1Result } from '@cloudflare/workers-types';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { artifactKeyPrefix, getArtifactStore } from '$lib/server/artifact-store';
import { newId, type Database } from '$lib/server/db';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext,
	type Page
} from './core';
import { artifactTypeOf } from './artifacts';
import { eventInsert } from './events';
import {
	resolveScope,
	scopeLabel,
	toContextScope,
	type ResolvedScope,
	type ScopeIds
} from './scope';

// ---------------------------------------------------------------------------
// Validation

const byteLength = (s: string) => new TextEncoder().encode(s).length;

function requireKind(value: unknown): ContextKind {
	if (typeof value !== 'string' || !(CONTEXT_KINDS as readonly string[]).includes(value)) {
		throw new ApiFail(
			422,
			'unknown_kind',
			`Unknown context kind ${JSON.stringify(value)}; allowed: ${CONTEXT_KINDS.join(', ')}`,
			{ field: 'kind', allowed_kinds: [...CONTEXT_KINDS] }
		);
	}
	return value as ContextKind;
}

function validateName(kind: ContextKind, value: unknown): string {
	const name = requireString(value, 'name', { max: 100 }).trim();
	if (name.length === 0 || name.length > 100) {
		throw new ApiFail(422, 'invalid_field', '"name" must be non-empty and at most 100 characters', {
			field: 'name'
		});
	}
	if ((kind === 'skill' || kind === 'artifact') && !SKILL_NAME_PATTERN.test(name)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`${kind === 'skill' ? 'Skill names double as workspace directory names' : 'Artifact names are the requirement-matching key and appear in CLI commands'}, so they must be slug-like ([a-z0-9-]+); got "${name}"`,
			{ field: 'name' }
		);
	}
	return name;
}

/** Workspace-relative path rules shared by skill files and repo dirs. */
export function validateWorkspacePath(path: unknown, field: string): string {
	const p = requireString(path, field, { max: 500 });
	const fail = (why: string) =>
		new ApiFail(422, 'invalid_path', `${field}: ${why} (got "${p}")`, { field, path: p });
	if (p.includes('\\')) throw fail('use forward slashes');
	if (p.startsWith('/')) throw fail('paths must be relative (no leading "/")');
	if (p.includes('=')) throw fail('paths cannot contain "="');
	const segments = p.split('/');
	if (segments.some((s) => s === '')) throw fail('paths cannot have empty segments or trailing slashes');
	if (segments.some((s) => s === '..' || s === '.')) throw fail('paths cannot contain "." or ".." segments');
	return p;
}

function validateFiles(value: unknown): ContextFile[] {
	if (!Array.isArray(value)) {
		throw new ApiFail(422, 'invalid_field', '"files" must be an array of { path, content }', {
			field: 'files'
		});
	}
	if (value.length > SKILL_MAX_FILES) {
		throw new ApiFail(
			422,
			'skill_too_large',
			`A skill can have at most ${SKILL_MAX_FILES} files (got ${value.length})`,
			{ field: 'files', max_files: SKILL_MAX_FILES }
		);
	}
	const files: ContextFile[] = [];
	const seen = new Set<string>();
	let total = 0;
	for (const [i, f] of value.entries()) {
		const input = f as { path?: unknown; content?: unknown };
		const path = validateWorkspacePath(input.path, `files[${i}].path`);
		if (seen.has(path)) {
			throw new ApiFail(422, 'duplicate_path', `Skill file path "${path}" is listed more than once`, {
				field: 'files',
				path
			});
		}
		seen.add(path);
		if (typeof input.content !== 'string') {
			throw new ApiFail(422, 'invalid_field', `"files[${i}].content" must be a string`, {
				field: 'files'
			});
		}
		total += byteLength(input.content) + byteLength(path);
		files.push({ path, content: input.content });
	}
	if (total > SKILL_MAX_TOTAL_BYTES) {
		throw new ApiFail(
			422,
			'skill_too_large',
			`A skill's files can total at most ${SKILL_MAX_TOTAL_BYTES} bytes of UTF-8 (got ${total})`,
			{ field: 'files', max_total_bytes: SKILL_MAX_TOTAL_BYTES }
		);
	}
	return files;
}

function validatePromptBody(value: unknown): string {
	if (typeof value !== 'string') {
		throw new ApiFail(422, 'invalid_field', 'A prompt needs a "body" (Markdown string)', {
			field: 'body'
		});
	}
	if (byteLength(value) > PROMPT_MAX_BYTES) {
		throw new ApiFail(
			422,
			'prompt_too_large',
			`A prompt body can be at most ${PROMPT_MAX_BYTES} bytes of UTF-8`,
			{ field: 'body', max_bytes: PROMPT_MAX_BYTES }
		);
	}
	return value;
}

/**
 * The payload fields a kind accepts. Fields belonging to other kinds are
 * rejected, not dropped — the API is strict by design.
 */
const KIND_FIELDS: Record<ContextKind, readonly string[]> = {
	prompt: ['body'],
	skill: ['files'],
	repo: ['repo_url', 'repo_branch', 'repo_dir'],
	// Artifact payloads (versions) never ride the generic context endpoints;
	// they go through the dedicated artifact routes only.
	artifact: []
};
const ALL_PAYLOAD_FIELDS = [...new Set(Object.values(KIND_FIELDS).flat())];

function rejectForeignPayload(kind: ContextKind, body: Record<string, unknown>) {
	const foreign = ALL_PAYLOAD_FIELDS.filter(
		(f) => body[f] !== undefined && !KIND_FIELDS[kind].includes(f)
	);
	if (foreign.length > 0) {
		throw new ApiFail(
			422,
			'kind_payload_mismatch',
			`Field${foreign.length === 1 ? '' : 's'} ${foreign.map((f) => `"${f}"`).join(', ')} do${foreign.length === 1 ? 'es' : ''} not belong to kind "${kind}"; allowed payload fields: ${KIND_FIELDS[kind].join(', ')}`,
			{ kind, rejected_fields: foreign, allowed_fields: [...KIND_FIELDS[kind]] }
		);
	}
}

// ---------------------------------------------------------------------------
// Loading

/** Base item query with the scope referents denormalized for display. */
export function contextItemQuery(db: Kysely<Database>, userId: string) {
	return db
		.selectFrom('context_item')
		.leftJoin('project as scope_project', 'scope_project.id', 'context_item.project_id')
		.leftJoin('workflow_state as scope_state', 'scope_state.id', 'context_item.workflow_state_id')
		.leftJoin('workflow as scope_workflow', 'scope_workflow.id', 'scope_state.workflow_id')
		.leftJoin('issue as scope_issue', 'scope_issue.id', 'context_item.issue_id')
		.leftJoin('project as issue_project', 'issue_project.id', 'scope_issue.project_id')
		.selectAll('context_item')
		.select([
			'scope_project.name as scope_project_name',
			'scope_state.name as scope_state_name',
			'scope_workflow.id as scope_workflow_id',
			'scope_workflow.name as scope_workflow_name',
			'scope_issue.number as scope_issue_number',
			'scope_issue.project_id as scope_issue_project_id',
			'issue_project.name as scope_issue_project_name'
		])
		.select((eb) =>
			eb
				.selectFrom('context_item_file')
				.whereRef('context_item_file.context_item_id', '=', 'context_item.id')
				.select((eb2) => eb2.fn.countAll<number>().as('n'))
				.as('file_count')
		)
		.where('context_item.user_id', '=', userId);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof contextItemQuery>['execute']>>[number];

function rowScope(row: ItemRow): ResolvedScope {
	return {
		projectId: row.project_id,
		workflowStateId: row.workflow_state_id,
		issueId: row.issue_id,
		projectName: row.scope_project_name,
		stateName: row.scope_state_name,
		workflowId: row.scope_workflow_id,
		workflowName: row.scope_workflow_name,
		issueNumber: row.scope_issue_number,
		issueProjectName: row.scope_issue_project_name,
		issueProjectId: row.scope_issue_project_id
	};
}

function serializeItem(row: ItemRow, files?: ContextFile[]): ContextItem {
	const kind = row.kind as ContextKind;
	const item: ContextItem = {
		id: row.id,
		kind,
		name: row.name,
		description: row.description,
		scope: toContextScope(rowScope(row)),
		position: row.position,
		version: row.version,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
	if (kind === 'prompt') item.body = row.body ?? '';
	if (kind === 'skill') {
		item.file_count = Number(row.file_count ?? 0);
		if (files) item.files = files;
	}
	if (kind === 'repo') {
		item.repo_url = row.repo_url ?? '';
		item.repo_branch = row.repo_branch;
		item.repo_dir = row.repo_dir;
	}
	// Artifacts: payload summarized — versions/contents live on the
	// dedicated artifact endpoints.
	if (kind === 'artifact') item.artifact_type = artifactTypeOf(row.config);
	return item;
}

async function loadFiles(
	db: Kysely<Database>,
	itemIds: string[]
): Promise<Map<string, ContextFile[]>> {
	const map = new Map<string, ContextFile[]>();
	if (itemIds.length === 0) return map;
	const rows = await db
		.selectFrom('context_item_file')
		.select(['context_item_id', 'path', 'content'])
		.where('context_item_id', 'in', itemIds)
		.orderBy('path asc')
		.execute();
	for (const row of rows) {
		const list = map.get(row.context_item_id) ?? [];
		list.push({ path: row.path, content: row.content });
		map.set(row.context_item_id, list);
	}
	return map;
}

export async function getContextItem(
	db: Kysely<Database>,
	userId: string,
	id: string
): Promise<ContextItem> {
	const row = await contextItemQuery(db, userId).where('context_item.id', '=', id).executeTakeFirst();
	if (!row) throw notFound();
	const files =
		row.kind === 'skill' ? ((await loadFiles(db, [row.id])).get(row.id) ?? []) : undefined;
	return serializeItem(row, files);
}

export interface ContextItemFilters {
	kind?: string;
	/** Project id or name. */
	project?: string;
	/** Workflow state id. */
	state?: string;
	/** Issue id. */
	issue?: string;
	/** Name/description substring search. */
	q?: string;
	/** Restrict to items whose scope sets only the given dimensions. */
	exact?: boolean;
}

/**
 * Lists items ordered `updated_at` desc then `id` desc (stable cursors; the
 * cursor's timestamp slot carries updated_at). Filters use "scope includes"
 * semantics; `exact` additionally requires unfiltered dimensions to be unset.
 */
export async function listContextItems(
	db: Kysely<Database>,
	userId: string,
	filters: ContextItemFilters,
	page: Page
): Promise<{ items: ContextItem[]; hasMore: boolean }> {
	let q = contextItemQuery(db, userId);
	if (filters.kind) {
		q = q.where('context_item.kind', '=', requireKind(filters.kind));
	}
	if (filters.project) {
		const p = filters.project;
		q = q.where((eb) =>
			eb.or([
				eb('context_item.project_id', '=', p),
				eb(
					'context_item.project_id',
					'in',
					eb.selectFrom('project').select('id').where('name', '=', p).where('user_id', '=', userId)
				)
			])
		);
	} else if (filters.exact) {
		q = q.where('context_item.project_id', 'is', null);
	}
	if (filters.state) {
		q = q.where('context_item.workflow_state_id', '=', filters.state);
	} else if (filters.exact) {
		q = q.where('context_item.workflow_state_id', 'is', null);
	}
	if (filters.issue) {
		q = q.where('context_item.issue_id', '=', filters.issue);
	} else if (filters.exact) {
		q = q.where('context_item.issue_id', 'is', null);
	}
	if (filters.q) {
		// Plain substring search; % and _ act as wildcards, which is harmless
		// (and occasionally useful) for a search box.
		const like = `%${filters.q}%`;
		q = q.where((eb) =>
			eb.or([
				eb('context_item.name', 'like', like),
				eb('context_item.description', 'like', like)
			])
		);
	}
	if (page.cursor) {
		const { createdAt: updatedAt, id } = page.cursor;
		q = q.where((eb) =>
			eb.or([
				eb('context_item.updated_at', '<', updatedAt),
				eb.and([eb('context_item.updated_at', '=', updatedAt), eb('context_item.id', '<', id)])
			])
		);
	}
	const rows = await q
		.orderBy('context_item.updated_at desc')
		.orderBy('context_item.id desc')
		.limit(page.limit + 1)
		.execute();
	return { items: rows.slice(0, page.limit).map((r) => serializeItem(r)), hasMore: rows.length > page.limit };
}

/** Items scoped to any of the given states (the workflow page's sections). */
export async function listContextItemsForStates(
	db: Kysely<Database>,
	userId: string,
	stateIds: string[]
): Promise<ContextItem[]> {
	if (stateIds.length === 0) return [];
	const rows = await contextItemQuery(db, userId)
		.where('context_item.workflow_state_id', 'in', stateIds)
		.orderBy('context_item.position asc')
		.orderBy('context_item.created_at asc')
		.execute();
	return rows.map((r) => serializeItem(r));
}

// ---------------------------------------------------------------------------
// Mutations

/**
 * Runs a context write batch, mapping a violation of the name-per-exact-scope
 * unique index (migration 0007) to the same `duplicate_context_name` code the
 * app-level check uses. The check-then-insert in assertNameAvailable is not
 * atomic, so a concurrent create/rename can slip past it and land here — and
 * callers (e.g. the CLI's journal create-race recovery) key off that code.
 */
async function runContextWrite(env: Env, queries: CompiledQuery[]): Promise<D1Result[]> {
	try {
		return await runAtomic(env, queries);
	} catch (e) {
		if (
			e instanceof Error &&
			e.message.includes('UNIQUE constraint failed') &&
			e.message.includes('context_item_name_scope_uq')
		) {
			throw new ApiFail(
				409,
				'duplicate_context_name',
				'A concurrent write created an item with this kind, name, and exact scope; re-read and retry',
				{ field: 'name' }
			);
		}
		throw e;
	}
}

async function assertNameAvailable(
	db: Kysely<Database>,
	userId: string,
	kind: ContextKind,
	name: string,
	scope: ScopeIds,
	excludeId?: string
) {
	let q = db
		.selectFrom('context_item')
		.select('id')
		.where('user_id', '=', userId)
		.where('kind', '=', kind)
		.where('name', '=', name);
	for (const [column, value] of [
		['project_id', scope.projectId],
		['workflow_state_id', scope.workflowStateId],
		['issue_id', scope.issueId]
	] as const) {
		q = value === null ? q.where(column, 'is', null) : q.where(column, '=', value);
	}
	if (excludeId) q = q.where('id', '!=', excludeId);
	const existing = await q.executeTakeFirst();
	if (existing) {
		throw new ApiFail(
			422,
			'duplicate_context_name',
			`A ${kind} named "${name}" already exists in this exact scope; names are unique per kind and scope (the same name in a different scope overrides instead)`,
			{ field: 'name', existing_item_id: existing.id }
		);
	}
}

async function nextPosition(db: Kysely<Database>, userId: string, scope: ScopeIds): Promise<number> {
	let q = db
		.selectFrom('context_item')
		.select((eb) => eb.fn.max('position').as('m'))
		.where('user_id', '=', userId);
	for (const [column, value] of [
		['project_id', scope.projectId],
		['workflow_state_id', scope.workflowStateId],
		['issue_id', scope.issueId]
	] as const) {
		q = value === null ? q.where(column, 'is', null) : q.where(column, '=', value);
	}
	const row = await q.executeTakeFirst();
	return row?.m === null || row?.m === undefined ? 0 : Number(row.m) + 1;
}

/** Event references derived from the scope, so feeds stay consistent. */
function eventRefs(scope: ResolvedScope): { issueId: string | null; projectId: string | null } {
	return {
		issueId: scope.issueId,
		projectId: scope.projectId ?? (scope.issueId ? scope.issueProjectId : null)
	};
}

function scopeEventPayload(scope: ResolvedScope) {
	return {
		project_id: scope.projectId,
		workflow_state_id: scope.workflowStateId,
		issue_id: scope.issueId,
		label: scopeLabel(scope)
	};
}

export async function createContextItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateContextItemRequest
): Promise<ContextItem> {
	const kind = requireKind(body.kind);
	// One creation path is saner than two, and file payloads can't ride a
	// JSON create: artifacts are created via their own endpoints only.
	if (kind === 'artifact') {
		throw new ApiFail(
			422,
			'use_artifact_endpoints',
			'Artifacts are created through the artifact endpoints: PUT /api/v1/issues/:id/artifacts/:name (JSON for text/link/pr) or …/:name/file (raw upload)',
			{ field: 'kind' }
		);
	}
	const name = validateName(kind, body.name);
	const description = optionalString(body.description, 'description', { max: 1000 }) ?? '';
	rejectForeignPayload(kind, body as unknown as Record<string, unknown>);

	const scope = await resolveScope(db, actor.userId, {
		projectId: body.project_id ?? null,
		workflowStateId: body.workflow_state_id ?? null,
		issueId: body.issue_id ?? null
	});
	await assertNameAvailable(db, actor.userId, kind, name, scope);

	let promptBody: string | null = null;
	let files: ContextFile[] = [];
	let repoUrl: string | null = null;
	let repoBranch: string | null = null;
	let repoDir: string | null = null;
	if (kind === 'prompt') {
		promptBody = validatePromptBody(body.body);
	} else if (kind === 'skill') {
		files = validateFiles(body.files ?? []);
	} else {
		repoUrl = requireString(body.repo_url, 'repo_url', { max: 1000 }).trim();
		repoBranch = optionalString(body.repo_branch, 'repo_branch', { max: 200 })?.trim() || null;
		repoDir =
			body.repo_dir === undefined || body.repo_dir === null
				? null
				: validateWorkspacePath(body.repo_dir, 'repo_dir');
	}

	const now = Date.now();
	const id = newId('ctx');
	const position = await nextPosition(db, actor.userId, scope);
	const queries: CompiledQuery[] = [
		db
			.insertInto('context_item')
			.values({
				id,
				user_id: actor.userId,
				kind,
				name,
				description,
				project_id: scope.projectId,
				workflow_state_id: scope.workflowStateId,
				issue_id: scope.issueId,
				body: promptBody,
				repo_url: repoUrl,
				repo_branch: repoBranch,
				repo_dir: repoDir,
				position,
				version: 1,
				created_at: now,
				updated_at: now
			})
			.compile(),
		...files.map((f) =>
			db
				.insertInto('context_item_file')
				.values({
					id: newId('ctf'),
					context_item_id: id,
					path: f.path,
					content: f.content,
					created_at: now,
					updated_at: now
				})
				.compile()
		),
		eventInsert(db, actor, {
			type: 'context.created',
			...eventRefs(scope),
			payload: { context_id: id, kind, name, scope: scopeEventPayload(scope) }
		})
	];
	await runContextWrite(env, queries);
	return getContextItem(db, actor.userId, id);
}

/**
 * Compiled guarded event insert: only lands if the item reached the given
 * version — ties an event to a compare-and-swap write in the same batch.
 */
function guardedContextEvent(
	db: Kysely<Database>,
	actor: ActorContext,
	input: { type: string; issueId: string | null; projectId: string | null; payload: Record<string, unknown> },
	itemId: string,
	versionAfter: number
): CompiledQuery {
	return sql`
		INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		SELECT ${newId('evt')}, ${actor.userId}, ${input.type}, ${actor.userId}, ${actor.apiKeyId},
			${input.issueId}, ${input.projectId}, ${JSON.stringify(input.payload)}, ${Date.now()}
		WHERE EXISTS (
			SELECT 1 FROM context_item WHERE id = ${itemId} AND version = ${versionAfter}
		)`.compile(db);
}

/** 409 carrying the current item so the caller can rebase and retry. */
function versionConflict(row: ItemRow): ApiFail {
	return new ApiFail(
		409,
		'version_conflict',
		`The item changed to version ${row.version} while this write was in flight; re-read and retry`,
		{ current: serializeItem(row) }
	);
}

export async function updateContextItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: UpdateContextItemRequest & { kind?: unknown },
	/** Internal: lost-race retry count for last-write-wins updates. */
	attempt = 0
): Promise<ContextItem> {
	const row = await contextItemQuery(db, actor.userId)
		.where('context_item.id', '=', id)
		.executeTakeFirst();
	if (!row) throw notFound();
	const kind = row.kind as ContextKind;

	if (body.expected_version !== undefined && body.expected_version !== row.version) {
		throw versionConflict(row);
	}

	if (body.kind !== undefined && body.kind !== kind) {
		throw new ApiFail(422, 'kind_immutable', 'A context item\'s kind cannot be changed after creation', {
			field: 'kind',
			kind
		});
	}
	rejectForeignPayload(kind, body as unknown as Record<string, unknown>);

	const name = body.name !== undefined ? validateName(kind, body.name) : row.name;
	const description =
		body.description !== undefined
			? (optionalString(body.description, 'description', { max: 1000 }) ?? '')
			: row.description;

	// Merge-patch scope: omitted = unchanged, explicit null = unset.
	const currentScope = rowScope(row);
	const scopeTouched =
		body.project_id !== undefined ||
		body.workflow_state_id !== undefined ||
		body.issue_id !== undefined;
	const targetIds: ScopeIds = {
		projectId: body.project_id !== undefined ? body.project_id : row.project_id,
		workflowStateId:
			body.workflow_state_id !== undefined ? body.workflow_state_id : row.workflow_state_id,
		issueId: body.issue_id !== undefined ? body.issue_id : row.issue_id
	};
	const scopeChanged =
		targetIds.projectId !== row.project_id ||
		targetIds.workflowStateId !== row.workflow_state_id ||
		targetIds.issueId !== row.issue_id;
	// Artifacts are pinned to exactly their issue: rename and description are
	// legitimate PATCHes here (a rename re-keys requirement matching, which
	// is the point), but the scope is structural and immutable.
	if (kind === 'artifact' && scopeChanged) {
		throw new ApiFail(
			422,
			'artifact_scope_invalid',
			'An artifact is scoped to exactly its issue; its scope cannot be changed',
			{ field: 'issue_id' }
		);
	}
	const scope =
		scopeTouched || scopeChanged ? await resolveScope(db, actor.userId, targetIds) : currentScope;

	if (name !== row.name || scopeChanged) {
		await assertNameAvailable(db, actor.userId, kind, name, targetIds, id);
	}

	// Payload updates per kind.
	let promptBody = row.body;
	if (kind === 'prompt' && body.body !== undefined) promptBody = validatePromptBody(body.body);
	let repoUrl = row.repo_url;
	let repoBranch = row.repo_branch;
	let repoDir = row.repo_dir;
	if (kind === 'repo') {
		if (body.repo_url !== undefined) repoUrl = requireString(body.repo_url, 'repo_url', { max: 1000 }).trim();
		if (body.repo_branch !== undefined) {
			repoBranch = optionalString(body.repo_branch, 'repo_branch', { max: 200 })?.trim() || null;
		}
		if (body.repo_dir !== undefined) {
			repoDir = body.repo_dir === null ? null : validateWorkspacePath(body.repo_dir, 'repo_dir');
		}
	}
	let files: ContextFile[] | undefined;
	if (kind === 'skill' && body.files !== undefined) files = validateFiles(body.files);

	// Position: re-scoping re-appends at the end of the target scope's
	// sequence; an explicit position (with or without a re-scope) wins.
	let position = row.position;
	if (scopeChanged) position = await nextPosition(db, actor.userId, targetIds);
	if (body.position !== undefined) {
		if (typeof body.position !== 'number' || !Number.isInteger(body.position)) {
			throw new ApiFail(422, 'invalid_field', '"position" must be an integer', { field: 'position' });
		}
		position = body.position;
	}

	// Summary diff for the context.updated event payload.
	const changed: string[] = [];
	if (name !== row.name) changed.push('name');
	if (description !== row.description) changed.push('description');
	if (scopeChanged) changed.push('scope');
	if (position !== row.position) changed.push('position');
	if (kind === 'prompt' && promptBody !== row.body) changed.push('body');
	if (kind === 'repo') {
		if (repoUrl !== row.repo_url) changed.push('repo_url');
		if (repoBranch !== row.repo_branch) changed.push('repo_branch');
		if (repoDir !== row.repo_dir) changed.push('repo_dir');
	}

	const payload: Record<string, unknown> = { context_id: id, kind, name, changed };
	if (name !== row.name) payload.renamed = { from: row.name, to: name };
	if (scopeChanged) {
		payload.scope_from = scopeEventPayload(currentScope);
		payload.scope_to = scopeEventPayload(scope);
	}
	payload.scope = scopeEventPayload(scope);

	const now = Date.now();
	const queries: CompiledQuery[] = [];
	let filesChanged = false;
	if (files !== undefined) {
		const currentFiles = (await loadFiles(db, [id])).get(id) ?? [];
		const currentByPath = new Map(currentFiles.map((f) => [f.path, f.content]));
		const nextByPath = new Map(files.map((f) => [f.path, f.content]));
		const added = files.filter((f) => !currentByPath.has(f.path)).map((f) => f.path);
		const removed = currentFiles.filter((f) => !nextByPath.has(f.path)).map((f) => f.path);
		const modified = files
			.filter((f) => currentByPath.has(f.path) && currentByPath.get(f.path) !== f.content)
			.map((f) => f.path);
		if (added.length || removed.length || modified.length) {
			filesChanged = true;
			changed.push('files');
			if (added.length) payload.files_added = added;
			if (removed.length) payload.files_removed = removed;
			if (modified.length) payload.files_modified = modified;
		}
	}

	if (changed.length === 0 && !filesChanged) return serializeItem(row, files);

	// Every write is a compare-and-swap on the version we read, so a
	// concurrent append or edit can never be half-overwritten: the guarded
	// update goes first, and the file replacement plus the event only land
	// if it did (they check for the bumped version).
	const newVersion = row.version + 1;
	queries.push(
		db
			.updateTable('context_item')
			.set({
				name,
				description,
				project_id: scope.projectId,
				workflow_state_id: scope.workflowStateId,
				issue_id: scope.issueId,
				body: promptBody,
				repo_url: repoUrl,
				repo_branch: repoBranch,
				repo_dir: repoDir,
				position,
				version: newVersion,
				updated_at: now
			})
			.where('id', '=', id)
			.where('version', '=', row.version)
			.compile()
	);
	if (filesChanged && files !== undefined) {
		// Declarative replace: the item is small by construction.
		queries.push(
			sql`DELETE FROM context_item_file WHERE context_item_id = ${id}
				AND EXISTS (SELECT 1 FROM context_item WHERE id = ${id} AND version = ${newVersion})`.compile(db)
		);
		for (const f of files) {
			queries.push(
				sql`INSERT INTO context_item_file (id, context_item_id, path, content, created_at, updated_at)
					SELECT ${newId('ctf')}, ${id}, ${f.path}, ${f.content}, ${now}, ${now}
					WHERE EXISTS (SELECT 1 FROM context_item WHERE id = ${id} AND version = ${newVersion})`.compile(db)
			);
		}
	}
	queries.push(
		guardedContextEvent(
			db,
			actor,
			{ type: 'context.updated', ...eventRefs(scope), payload },
			id,
			newVersion
		)
	);
	const results = await runContextWrite(env, queries);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		const fresh = await contextItemQuery(db, actor.userId)
			.where('context_item.id', '=', id)
			.executeTakeFirst();
		if (!fresh) throw notFound();
		// An explicit expectation surfaces the conflict; otherwise this is
		// last-write-wins, so re-apply the merge-patch onto the fresh row.
		if (body.expected_version !== undefined || attempt >= 3) throw versionConflict(fresh);
		return updateContextItem(db, env, actor, id, body, attempt + 1);
	}
	return getContextItem(db, actor.userId, id);
}

export async function deleteContextItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string
): Promise<void> {
	const row = await contextItemQuery(db, actor.userId)
		.where('context_item.id', '=', id)
		.executeTakeFirst();
	if (!row) throw notFound();
	const scope = rowScope(row);
	await runAtomic(env, [
		db.deleteFrom('context_item_file').where('context_item_id', '=', id).compile(),
		db
			.deleteFrom('artifact_version_file')
			.where(
				'artifact_version_id',
				'in',
				db.selectFrom('artifact_version').select('id').where('context_item_id', '=', id)
			)
			.compile(),
		db.deleteFrom('artifact_version').where('context_item_id', '=', id).compile(),
		db.deleteFrom('context_item').where('id', '=', id).compile(),
		eventInsert(db, actor, {
			type: 'context.deleted',
			...eventRefs(scope),
			payload: { context_id: id, kind: row.kind, name: row.name, scope: scopeEventPayload(scope) }
		})
	]);
	if (row.kind === 'artifact') {
		// D1 first, then best-effort R2 — an orphaned object is the accepted
		// failure mode, never a row referencing a missing object.
		await getArtifactStore(env)
			.deletePrefix(artifactKeyPrefix(actor.userId, id))
			.catch(() => {});
	}
}

/**
 * Atomic append to a prompt item's body: the new text lands after exactly
 * one blank line. Every attempt is a compare-and-swap on the version it
 * read, retried on a lost race, so two concurrent appends both land and an
 * append never clobbers (or is clobbered by) a concurrent rewrite.
 */
export async function appendContextItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	id: string,
	body: AppendContextRequest
): Promise<ContextItem> {
	const text = requireString(body.text, 'text', { max: PROMPT_MAX_BYTES }).trim();
	for (let attempt = 0; ; attempt++) {
		const row = await contextItemQuery(db, actor.userId)
			.where('context_item.id', '=', id)
			.executeTakeFirst();
		if (!row) throw notFound();
		if (row.kind !== 'prompt') {
			throw new ApiFail(422, 'not_a_prompt', `Only prompt items can be appended to (this is a ${row.kind})`, {
				kind: row.kind
			});
		}
		if (body.expected_version !== undefined && body.expected_version !== row.version) {
			throw versionConflict(row);
		}
		const current = (row.body ?? '').trimEnd();
		const nextBody = current ? `${current}\n\n${text}` : text;
		validatePromptBody(nextBody);

		const scope = rowScope(row);
		const newVersion = row.version + 1;
		const now = Date.now();
		const results = await runAtomic(env, [
			db
				.updateTable('context_item')
				.set({ body: nextBody, version: newVersion, updated_at: now })
				.where('id', '=', id)
				.where('version', '=', row.version)
				.compile(),
			guardedContextEvent(
				db,
				actor,
				{
					type: 'context.updated',
					...eventRefs(scope),
					payload: {
						context_id: id,
						kind: row.kind,
						name: row.name,
						changed: ['body'],
						appended: true,
						scope: scopeEventPayload(scope)
					}
				},
				id,
				newVersion
			)
		]);
		if ((results[0]?.meta.changes ?? 0) > 0) return getContextItem(db, actor.userId, id);
		// Lost the race: with an explicit expectation that's a conflict;
		// otherwise re-read and re-append onto the fresh body.
		if (body.expected_version !== undefined || attempt >= 4) {
			const fresh = await contextItemQuery(db, actor.userId)
				.where('context_item.id', '=', id)
				.executeTakeFirst();
			if (!fresh) throw notFound();
			throw versionConflict(fresh);
		}
	}
}

// ---------------------------------------------------------------------------
// Effective context

/**
 * The journal convention: the prompt item named `journal` scoped to exactly
 * project ∧ state — the item the `tines journal` commands target, rendered
 * under a `## Journal (<scope label>)` heading in the stitched prompt.
 */
export function isJournal(row: {
	kind: string;
	name: string;
	project_id: string | null;
	workflow_state_id: string | null;
	issue_id: string | null;
}): boolean {
	return (
		row.kind === 'prompt' &&
		row.name === JOURNAL_NAME &&
		row.project_id !== null &&
		row.workflow_state_id !== null &&
		row.issue_id === null
	);
}

/**
 * Layer rank of an exact scope. Treating (issue, state, project) as bits of
 * a binary number yields exactly the spec's seven-layer order — global (0),
 * project (1), state (2), project ∧ state (3), issue (4), issue ∧ project
 * (5), issue ∧ state (6), issue ∧ project ∧ state (7) — any issue-anchored
 * scope outranks any non-issue-anchored one. Broad layers stitch first.
 */
export function layerRank(scope: {
	projectId?: string | null;
	workflowStateId?: string | null;
	issueId?: string | null;
}): number {
	return (scope.issueId ? 4 : 0) + (scope.workflowStateId ? 2 : 0) + (scope.projectId ? 1 : 0);
}

export interface StitchPart {
	label: string;
	body: string;
	/** Journal parts render under `## Journal (<label>)` (display-only). */
	isJournal?: boolean;
}

/**
 * Stitches prompt parts (already in layer order) into one Markdown document:
 * each trimmed body under a `## Context: <scope label>` heading (the journal
 * under `## Journal (<scope label>)`), separated by exactly one blank line.
 */
export function stitchPrompt(parts: StitchPart[]): string {
	return parts
		.flatMap((p) => {
			const body = p.body.trim();
			const heading = p.isJournal ? `## Journal (${p.label})` : `## Context: ${p.label}`;
			return [heading, ...(body ? [body] : [])];
		})
		.join('\n\n');
}

interface MatchTarget {
	projectId: string;
	stateId: string;
	issueId: string;
}

function matchingItemsQuery(db: Kysely<Database>, userId: string, target: MatchTarget) {
	// Artifacts are deliberately not part of the effective context: nothing
	// is stitched into the prompt, nothing is seeded into a workspace.
	return contextItemQuery(db, userId)
		.where('context_item.kind', '!=', 'artifact')
		.where((eb) =>
		eb.and([
			eb.or([eb('context_item.project_id', 'is', null), eb('context_item.project_id', '=', target.projectId)]),
			eb.or([
				eb('context_item.workflow_state_id', 'is', null),
				eb('context_item.workflow_state_id', '=', target.stateId)
			]),
			eb.or([eb('context_item.issue_id', 'is', null), eb('context_item.issue_id', '=', target.issueId)])
		])
	);
}

/** Layer order, then position / created_at / id within a layer. */
function sortMatched(rows: ItemRow[]): ItemRow[] {
	return [...rows].sort(
		(a, b) =>
			layerRank(rowScope(a)) - layerRank(rowScope(b)) ||
			a.position - b.position ||
			a.created_at - b.created_at ||
			(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}

/** Dedupe by name within a kind: the later (more specific) item wins wholesale. */
function dedupeByName(rows: ItemRow[]): { winners: ItemRow[]; overridden: OverriddenContextItem[] } {
	const byName = new Map<string, ItemRow>();
	const losers: { row: ItemRow; winner: ItemRow }[] = [];
	for (const row of rows) {
		const prev = byName.get(row.name);
		if (prev) losers.push({ row: prev, winner: row });
		byName.set(row.name, row);
	}
	const winners = rows.filter((r) => byName.get(r.name) === r);
	return {
		winners,
		overridden: losers.map(({ row, winner }) => ({
			item_id: row.id,
			kind: row.kind as ContextKind,
			name: row.name,
			scope: toContextScope(rowScope(row)),
			overridden_by: winner.id
		}))
	};
}

async function issueMatchTarget(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<MatchTarget> {
	const issue = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue.id', 'issue.project_id', 'issue.state_id'])
		.where('issue.id', '=', issueId)
		.where('project.user_id', '=', userId)
		.executeTakeFirst();
	if (!issue) throw notFound();
	return { projectId: issue.project_id, stateId: issue.state_id, issueId: issue.id };
}

/**
 * The assembled bundle for an issue, computed on read. Pass
 * `skillFiles: false` for a display-only bundle (skill file contents can be
 * large; `file_count` is populated either way) — the launch-prompt and
 * bundle-fetch paths need the contents, list/preview surfaces do not.
 */
export async function effectiveContextForIssue(
	db: Kysely<Database>,
	userId: string,
	issueId: string,
	{ skillFiles = true }: { skillFiles?: boolean } = {}
): Promise<EffectiveContext> {
	const target = await issueMatchTarget(db, userId, issueId);
	const rows = sortMatched(await matchingItemsQuery(db, userId, target).execute());

	const prompts = rows.filter((r) => r.kind === 'prompt');
	const parts: EffectivePromptPart[] = prompts.map((r) => ({
		item_id: r.id,
		name: r.name,
		scope: toContextScope(rowScope(r)),
		body: r.body ?? '',
		version: r.version,
		is_journal: isJournal(r)
	}));
	const text = stitchPrompt(
		parts.map((p) => ({ label: p.scope.label, body: p.body, isJournal: p.is_journal }))
	);

	const skillDedupe = dedupeByName(rows.filter((r) => r.kind === 'skill'));
	const repoDedupe = dedupeByName(rows.filter((r) => r.kind === 'repo'));

	const fileMap = skillFiles
		? await loadFiles(db, skillDedupe.winners.map((r) => r.id))
		: new Map<string, ContextFile[]>();
	const skills: EffectiveSkill[] = skillDedupe.winners.map((r) => ({
		item_id: r.id,
		name: r.name,
		scope: toContextScope(rowScope(r)),
		files: fileMap.get(r.id) ?? [],
		file_count: Number(r.file_count ?? 0),
		version: r.version
	}));

	const repos: EffectiveRepo[] = repoDedupe.winners.map((r) => ({
		item_id: r.id,
		name: r.name,
		scope: toContextScope(rowScope(r)),
		url: r.repo_url ?? '',
		branch: r.repo_branch,
		dir: r.repo_dir ?? repoDirFromUrl(r.repo_url ?? ''),
		version: r.version
	}));

	// Post-dedupe checkout-directory collisions are kept but flagged.
	const byDir = new Map<string, string[]>();
	for (const repo of repos) {
		byDir.set(repo.dir, [...(byDir.get(repo.dir) ?? []), repo.item_id]);
	}
	const conflicts: RepoDirConflict[] = [...byDir.entries()]
		.filter(([, ids]) => ids.length > 1)
		.map(([dir, item_ids]) => ({ kind: 'repo_dir', dir, item_ids }));

	return {
		prompt: { text, parts },
		skills,
		repos,
		overridden: [...skillDedupe.overridden, ...repoDedupe.overridden],
		conflicts
	};
}

/**
 * Per-kind counts of the currently effective context, post-dedupe — the
 * issue read's lightweight `context_summary`. One cheap query, no joins.
 */
export async function contextSummaryForIssue(
	db: Kysely<Database>,
	userId: string,
	target: { projectId: string; stateId: string; issueId: string }
): Promise<ContextSummary> {
	const rows = await db
		.selectFrom('context_item')
		.select(['kind', 'name'])
		.where('user_id', '=', userId)
		.where((eb) =>
			eb.and([
				eb.or([eb('project_id', 'is', null), eb('project_id', '=', target.projectId)]),
				eb.or([eb('workflow_state_id', 'is', null), eb('workflow_state_id', '=', target.stateId)]),
				eb.or([eb('issue_id', 'is', null), eb('issue_id', '=', target.issueId)])
			])
		)
		.execute();
	return {
		prompts: rows.filter((r) => r.kind === 'prompt').length,
		skills: new Set(rows.filter((r) => r.kind === 'skill').map((r) => r.name)).size,
		repos: new Set(rows.filter((r) => r.kind === 'repo').map((r) => r.name)).size,
		// Artifacts are issue-scoped by construction, so the matching rows are
		// exactly this issue's attachments (a badge count, not effective context).
		artifacts: rows.filter((r) => r.kind === 'artifact').length
	};
}

// ---------------------------------------------------------------------------
// Launch prompt

/**
 * The generated issue block: purely factual, with runnable CLI commands for
 * commenting, each available transition, and the journal — the one item the
 * prompt hands a write affordance for. No item ids appear anywhere; the
 * journal is addressed by the issue ref. Format is part of the spec.
 */
function artifactLine(ref: string, artifact: Artifact): string[] {
	const cv = artifact.current_version;
	const marks: string[] = [artifact.artifact_type];
	const fetchable =
		artifact.artifact_type === 'file' ||
		artifact.artifact_type === 'text' ||
		artifact.artifact_type === 'folder';
	if (fetchable) {
		if (artifact.artifact_type === 'folder') {
			marks.push(`${cv.file_count ?? 0} file${cv.file_count === 1 ? '' : 's'}`);
		} else if (cv.content_type) {
			marks.push(cv.content_type);
		}
		marks.push(`v${cv.version}`, artifact.fresh ? 'fresh' : 'attached before current state');
	}
	const reference =
		artifact.artifact_type === 'link'
			? cv.url
			: artifact.artifact_type === 'pr'
				? `${cv.pr_repo_url}/pull/${cv.pr_number}`
				: null;
	const tail = artifact.description || reference;
	const lines = [`- **${artifact.name}** (${marks.join(', ')})${tail ? ` — ${tail}` : ''}`];
	if (fetchable) {
		lines.push(`  Fetch: \`tines issues artifacts get ${ref} ${artifact.name} --out .\``);
	}
	return lines;
}

/** The status suffix for a transition's requirement line in the prompt. */
function requirementStatusLabel(r: ArtifactRequirementCheck): string {
	switch (r.status) {
		case 'satisfied':
			return `satisfied (v${r.current_version?.version}, fresh)`;
		case 'missing':
			return '**missing; attach it first**';
		case 'stale':
			return '**stale; attach a new version (or reaffirm) first**';
		case 'type_mismatch':
			return '**type mismatch; the attached artifact does not satisfy it**';
	}
}

export function issueBlock(
	issue: IssueDetail,
	context: EffectiveContext,
	issueArtifacts: Artifact[] = []
): string {
	const ref = `${issue.project_name}/${issue.number}`;
	const lines: string[] = [`## Issue: ${ref} — ${issue.title}`, ''];
	if (issue.description.trim()) {
		lines.push(issue.description.trim(), '');
	}
	lines.push(
		'### Current state',
		'',
		`${issue.state.name} (${issue.state.category}), in workflow "${issue.workflow.name}".`,
		'',
		'### Comments',
		''
	);
	if (issue.comments.length === 0) {
		lines.push('No comments yet.', '');
	} else {
		for (const comment of issue.comments) {
			const actor = actorLabel(comment.actor);
			lines.push(
				`**${actor}** (${new Date(comment.created_at).toISOString()}):`,
				comment.body.trim(),
				''
			);
		}
	}
	lines.push(`Add a comment: \`tines issues comment ${ref} "<markdown>"\``, '', '### Artifacts', '');
	// A listing, never contents: agents fetch on demand.
	if (issueArtifacts.length === 0) {
		lines.push('No artifacts attached.', '');
	} else {
		for (const artifact of issueArtifacts) {
			lines.push(...artifactLine(ref, artifact));
		}
		lines.push('');
	}
	lines.push(
		`Attach one: \`tines issues artifacts attach ${ref} <name> --file <path>\` (or --text/--url/--pr, or --folder <dir> for a multi-file snapshot)`,
		'',
		'### Available transitions',
		''
	);
	if (issue.allowed_transitions.length === 0) {
		lines.push('None — this state is terminal.');
	} else {
		for (const t of issue.allowed_transitions) {
			lines.push(
				`- **${t.name}** → ${t.to_state.name} (${t.to_state.category}): \`tines issues move ${ref} "${t.name}"\``
			);
			// Each requirement with live status, so the prompt alone tells the
			// agent both its legal moves and their preconditions.
			for (const r of t.requires ?? []) {
				const spec = [r.type, r.content_type].filter(Boolean).join(', ');
				lines.push(
					`  Requires: artifact \`${r.artifact}\`${spec ? ` (${spec})` : ''} — ${requirementStatusLabel(r)}${r.description ? ` — ${r.description}` : ''}`
				);
			}
		}
	}

	// The journal affordance sits prompt-final, where recency favors it.
	lines.push('', '### Journal', '');
	const journal = context.prompt.parts.find((p) => p.is_journal);
	if (journal) {
		lines.push(
			'Your journal for this project and stage is the "Journal" section above',
			`(currently v${journal.version}).`,
			'',
			`- Append a lesson: \`tines journal append ${ref} "- <date>: <lesson>"\``,
			`- Fix or prune entries: \`tines journal show ${ref} --json\`, revise, then`,
			`  \`tines journal rewrite ${ref} --body @file --expect-version ${journal.version}\``
		);
	} else {
		lines.push(
			`No journal exists yet for project ${issue.project_name} · state ${issue.state.name}. Start one:`,
			`\`tines journal append ${ref} "- <date>: <lesson>"\``
		);
	}

	// Factual footnotes: this issue's effective artifacts (with the fetch
	// command — the agent's own attachments are fair game), then the other
	// prompt items by name and scope label only, whose sole affordance is
	// the proposal convention.
	const artifacts = [
		...context.skills.map(
			(s) => `skill "${s.name}" (${s.file_count} file${s.file_count === 1 ? '' : 's'})`
		),
		...context.repos.map((r) => `repo "${r.name}"${r.branch ? ` (branch ${r.branch})` : ''}`)
	];
	if (artifacts.length > 0) {
		lines.push(
			'',
			`Attached to this issue: ${artifacts.join(', ')}. Fetch them: \`tines issues context ${ref} --out <dir>\``
		);
	}
	const shared = context.prompt.parts.filter((p) => !p.is_journal && p.scope.issue_id === null);
	if (shared.length > 0) {
		lines.push(
			'',
			`Also in effect: ${shared.map((p) => `prompt "${p.name}" (${p.scope.label})`).join(', ')}. These are`,
			'shared — to change one, file an issue titled `Context change: <scope label>`.'
		);
	}
	return lines.join('\n').trimEnd();
}

/** Context first, the issue block last — the task sits nearest the end. */
export function buildLaunchPrompt(
	context: EffectiveContext,
	issue: IssueDetail,
	issueArtifacts: Artifact[] = []
): string {
	const text = context.prompt.text.trim();
	const block = issueBlock(issue, context, issueArtifacts);
	return text ? `${text}\n\n${block}` : block;
}

// ---------------------------------------------------------------------------
// Lifecycle: anchors reject deletion by default; `force` cascades

export interface AttachedContextItem {
	id: string;
	kind: ContextKind;
	name: string;
	scope: ResolvedScope;
}

function toDeleted(item: AttachedContextItem): DeletedContextItem {
	return { id: item.id, kind: item.kind, name: item.name, scope_label: scopeLabel(item.scope) };
}

/** Items whose scope references any of the given anchors. */
export async function findAttachedContext(
	db: Kysely<Database>,
	userId: string,
	anchor: { projectId?: string; stateIds?: string[] }
): Promise<AttachedContextItem[]> {
	if (anchor.stateIds !== undefined && anchor.stateIds.length === 0) return [];
	let q = contextItemQuery(db, userId);
	if (anchor.projectId !== undefined) q = q.where('context_item.project_id', '=', anchor.projectId);
	if (anchor.stateIds !== undefined) {
		q = q.where('context_item.workflow_state_id', 'in', anchor.stateIds);
	}
	const rows = await q.orderBy('context_item.created_at asc').orderBy('context_item.id asc').execute();
	return rows.map((row) => ({
		id: row.id,
		kind: row.kind as ContextKind,
		name: row.name,
		scope: rowScope(row)
	}));
}

/**
 * Rejects the operation (422 naming the attached items) unless forced; when
 * forced, returns the delete statements plus one `context.deleted` event per
 * item, to be committed in the caller's batch. All-or-nothing per request.
 */
export function sweepAttachedContext(
	db: Kysely<Database>,
	actor: ActorContext,
	items: AttachedContextItem[],
	force: boolean,
	operation: string
): { queries: CompiledQuery[]; deleted: DeletedContextItem[] } {
	if (items.length === 0) return { queries: [], deleted: [] };
	if (!force) {
		throw new ApiFail(
			422,
			'context_attached',
			`Cannot ${operation}: ${items.length} context item${items.length === 1 ? ' is' : 's are'} scoped to it (${items
				.map((i) => `${i.kind} "${i.name}" [${scopeLabel(i.scope)}]`)
				.join(', ')}). Pass "force_delete_context": true to delete them too.`,
			{ context_items: items.map(toDeleted) }
		);
	}
	const queries = items.flatMap((item) => [
		db.deleteFrom('context_item_file').where('context_item_id', '=', item.id).compile(),
		db.deleteFrom('context_item').where('id', '=', item.id).compile(),
		eventInsert(db, actor, {
			type: 'context.deleted',
			...eventRefs(item.scope),
			payload: {
				context_id: item.id,
				kind: item.kind,
				name: item.name,
				scope: scopeEventPayload(item.scope),
				forced: true
			}
		})
	]);
	return { queries, deleted: items.map(toDeleted) };
}

// ---------------------------------------------------------------------------
// Seeding: creation-time prompts and the starter agent guidance

/**
 * Statements creating a prompt item plus its context.created event, for
 * riding along in a creation batch (project / workflow-state creation).
 * The anchor is brand new, so the exact scope is empty by construction and
 * the conventional name cannot collide.
 */
export function seedPromptQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		name: string;
		body: string;
		projectId?: string;
		workflowStateId?: string;
		/** Canonical scope label at creation time, for the event payload. */
		label: string;
		now: number;
	}
): { id: string; queries: CompiledQuery[] } {
	validatePromptBody(opts.body);
	const id = newId('ctx');
	const projectId = opts.projectId ?? null;
	const workflowStateId = opts.workflowStateId ?? null;
	return {
		id,
		queries: [
			db
				.insertInto('context_item')
				.values({
					id,
					user_id: actor.userId,
					kind: 'prompt',
					name: opts.name,
					description: '',
					project_id: projectId,
					workflow_state_id: workflowStateId,
					issue_id: null,
					body: opts.body,
					repo_url: null,
					repo_branch: null,
					repo_dir: null,
					position: 0,
					version: 1,
					created_at: opts.now,
					updated_at: opts.now
				})
				.compile(),
			eventInsert(db, actor, {
				type: 'context.created',
				projectId,
				payload: {
					context_id: id,
					kind: 'prompt',
					name: opts.name,
					scope: {
						project_id: projectId,
						workflow_state_id: workflowStateId,
						issue_id: null,
						label: opts.label
					}
				}
			})
		]
	};
}

/** Seeds the global agent-guidelines prompt once; a no-op if it exists. */
export async function ensureAgentGuidelines(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext
): Promise<'created' | 'exists'> {
	const existing = await db
		.selectFrom('context_item')
		.select('id')
		.where('user_id', '=', actor.userId)
		.where('kind', '=', 'prompt')
		.where('name', '=', AGENT_GUIDELINES_NAME)
		.where('project_id', 'is', null)
		.where('workflow_state_id', 'is', null)
		.where('issue_id', 'is', null)
		.executeTakeFirst();
	if (existing) return 'exists';
	await createContextItem(db, env, actor, {
		kind: 'prompt',
		name: AGENT_GUIDELINES_NAME,
		description: AGENT_GUIDELINES_DESCRIPTION,
		body: AGENT_GUIDELINES_BODY
	});
	return 'created';
}
