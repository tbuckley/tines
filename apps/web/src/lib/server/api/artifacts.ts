/**
 * Issue artifacts (specs/artifacts/SPEC.md): context items of kind
 * `artifact` — named, typed slots on an issue, each with an immutable
 * version history — plus the freshness/requirement machinery workflow
 * transitions gate on.
 *
 * Creation and payload writes go through the endpoints in this module only;
 * the generic context endpoints still read, rename, and delete artifact
 * items (see context.ts). File bytes live in R2 behind the ArtifactStore
 * interface; everything else is D1.
 */
import {
	ARTIFACT_FILE_MAX_BYTES,
	ARTIFACT_FOLDER_MAX_BYTES,
	ARTIFACT_FOLDER_MAX_FILES,
	ARTIFACT_MAX_VERSIONS,
	ARTIFACT_NAME_PATTERN,
	ARTIFACT_TEXT_MAX_BYTES,
	ARTIFACT_TYPES,
	canonicalGitHubRepoUrl,
	parsePrSpec,
	requirementFix,
	type Artifact,
	type ArtifactDetail,
	type ArtifactRequirement,
	type ArtifactRequirementCheck,
	type ArtifactRequirementStatus,
	type ArtifactType,
	type ArtifactVersion,
	type ArtifactVersionFile,
	type UpsertArtifactRequest
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import {
	artifactFileKey,
	artifactKey,
	artifactKeyPrefix,
	getArtifactStore
} from '$lib/server/artifact-store';
import { idChunks, newId, type Database } from '$lib/server/db';
import { assertWritable } from './archive';
import { ApiFail, notFound, optionalString, runAtomic, type ActorContext } from './core';
import { actorOf, eventInsert } from './events';

const byteLength = (s: string) => new TextEncoder().encode(s).length;

// ---------------------------------------------------------------------------
// Validation

export function validateArtifactName(value: string): string {
	const name = value.trim();
	if (name.length === 0 || name.length > 100 || !ARTIFACT_NAME_PATTERN.test(name)) {
		throw new ApiFail(
			422,
			'invalid_field',
			`Artifact names are the requirement-matching key and appear in CLI commands, so they must be slug-like ([a-z0-9-]+, at most 100 chars); got "${name}"`,
			{ field: 'name' }
		);
	}
	return name;
}

function requireArtifactType(value: unknown): ArtifactType {
	if (typeof value !== 'string' || !(ARTIFACT_TYPES as readonly string[]).includes(value)) {
		throw new ApiFail(
			422,
			'unknown_artifact_type',
			`Unknown artifact type ${JSON.stringify(value)}; allowed: ${ARTIFACT_TYPES.join(', ')}`,
			{ field: 'type', allowed_types: [...ARTIFACT_TYPES] }
		);
	}
	return value as ArtifactType;
}

/**
 * The JSON-upsert payload fields per type. `file` versions can only be
 * attached through the raw-body endpoint, so no JSON field belongs to it.
 */
const TYPE_FIELDS: Record<ArtifactType, readonly string[]> = {
	file: [],
	folder: [],
	text: ['content', 'filename', 'content_type'],
	link: ['url', 'title'],
	pr: ['pr_url', 'pr_repo_url', 'pr_number']
};
const ALL_TYPE_FIELDS = [...new Set(Object.values(TYPE_FIELDS).flat())];

function payloadFieldsPresent(body: Record<string, unknown>): string[] {
	return ALL_TYPE_FIELDS.filter((f) => body[f] !== undefined);
}

function rejectForeignPayload(type: ArtifactType, body: Record<string, unknown>): void {
	const foreign = payloadFieldsPresent(body).filter((f) => !TYPE_FIELDS[type].includes(f));
	if (foreign.length > 0) {
		throw new ApiFail(
			422,
			'artifact_payload_mismatch',
			`Field${foreign.length === 1 ? '' : 's'} ${foreign.map((f) => `"${f}"`).join(', ')} do${foreign.length === 1 ? 'es' : ''} not belong to artifact type "${type}"${TYPE_FIELDS[type].length > 0 ? `; allowed payload fields: ${TYPE_FIELDS[type].join(', ')}` : type === 'file' ? '; file contents are uploaded through the raw-body …/file endpoint' : ''}`,
			{ type, rejected_fields: foreign, allowed_fields: [...TYPE_FIELDS[type]] }
		);
	}
}

/** Display filename: a basename, not a path — no separators or dot-segments. */
function validateFilename(value: string, field = 'filename'): string {
	const name = value.trim();
	if (
		name.length === 0 ||
		name.length > 200 ||
		name.includes('/') ||
		name.includes('\\') ||
		name === '.' ||
		name === '..'
	) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"${field}" must be a plain file name (no path separators, at most 200 chars); got "${name}"`,
			{ field }
		);
	}
	return name;
}

/**
 * Folder entry paths: the workspace-path rules (forward slashes, no dot
 * segments, no `\` or `=`), plus no `"` — multipart filenames can't carry
 * quotes reliably across implementations.
 */
function validateFolderPath(value: string): string {
	const path = value.trim();
	const fail = (why: string) =>
		new ApiFail(422, 'invalid_path', `folder file path: ${why} (got "${path}")`, { path });
	if (path.length === 0 || path.length > 500) throw fail('must be non-empty and at most 500 chars');
	if (path.includes('\\')) throw fail('use forward slashes');
	if (path.startsWith('/')) throw fail('paths must be relative (no leading "/")');
	if (path.includes('=') || path.includes('"')) throw fail(`paths cannot contain "=" or '"'`);
	const segments = path.split('/');
	if (segments.some((s) => s === ''))
		throw fail('paths cannot have empty segments or trailing slashes');
	if (segments.some((s) => s === '.' || s === '..'))
		throw fail('paths cannot contain "." or ".." segments');
	return path;
}

function validateContentType(value: string, field = 'content_type'): string {
	const type = value.trim().toLowerCase();
	if (!/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type) || type.length > 100) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"${field}" must be a MIME type like "text/markdown"; got "${value}"`,
			{
				field
			}
		);
	}
	return type;
}

// ---------------------------------------------------------------------------
// Loading

interface IssueRef {
	id: string;
	projectId: string;
	projectName: string;
	projectArchivedAt: number | null;
	number: number;
	stateEnteredAt: number;
}

/** The gate's view of an artifact issue's project. */
function artifactProject(issue: IssueRef) {
	return { id: issue.projectId, name: issue.projectName, archived_at: issue.projectArchivedAt };
}

async function requireIssue(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<IssueRef> {
	const row = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select([
			'issue.id',
			'issue.project_id',
			'issue.number',
			'issue.state_entered_at',
			'issue.created_at',
			'project.name as project_name',
			'project.archived_at as project_archived_at'
		])
		.where('issue.id', '=', issueId)
		.where('project.user_id', '=', userId)
		.executeTakeFirst();
	if (!row) throw notFound();
	return {
		id: row.id,
		projectId: row.project_id,
		projectName: row.project_name,
		projectArchivedAt: row.project_archived_at,
		number: row.number,
		stateEnteredAt: Number(row.state_entered_at ?? row.created_at)
	};
}

function itemQuery(db: Kysely<Database>, userId: string, issueId: string) {
	return db
		.selectFrom('context_item')
		.selectAll()
		.where('user_id', '=', userId)
		.where('kind', '=', 'artifact')
		.where('issue_id', '=', issueId);
}

type ItemRow = Awaited<ReturnType<ReturnType<typeof itemQuery>['execute']>>[number];

export function versionQuery(db: Kysely<Database>) {
	return (
		db
			.selectFrom('artifact_version')
			.leftJoin('user as actor_user', 'actor_user.id', 'artifact_version.actor_user_id')
			.leftJoin('api_key', 'api_key.id', 'artifact_version.actor_api_key_id')
			// Run-key attribution, as in the comment/event queries.
			.leftJoin('agent_run as actor_run', 'actor_run.id', 'api_key.agent_run_id')
			.leftJoin('runner as actor_runner', 'actor_runner.id', 'actor_run.runner_id')
			.leftJoin('issue as actor_run_issue', 'actor_run_issue.id', 'actor_run.issue_id')
			.leftJoin(
				'project as actor_run_project',
				'actor_run_project.id',
				'actor_run_issue.project_id'
			)
			.selectAll('artifact_version')
			.select([
				'actor_user.name as actor_user_name',
				'api_key.name as actor_api_key_name',
				'actor_run.id as actor_run_id',
				// The run's own issue: a version attributed to a run on *another*
				// issue must not be folded into this issue's round.
				'actor_run.issue_id as actor_run_issue_id',
				'actor_runner.name as actor_runner_name',
				'actor_run_project.name as actor_run_project_name',
				'actor_run_issue.number as actor_run_issue_number'
			])
	);
}

type VersionRow = Awaited<ReturnType<ReturnType<typeof versionQuery>['execute']>>[number];

export function artifactTypeOf(config: string | null): ArtifactType {
	try {
		const parsed = JSON.parse(config ?? '{}') as { artifact_type?: unknown };
		if (
			typeof parsed.artifact_type === 'string' &&
			(ARTIFACT_TYPES as readonly string[]).includes(parsed.artifact_type)
		) {
			return parsed.artifact_type as ArtifactType;
		}
	} catch {
		// Fall through to the conservative default below.
	}
	return 'file';
}

type FileRow = Database['artifact_version_file'];

/** Folder-version files keyed by version row id (empty for other types). */
type FilesByVersion = Map<string, FileRow[]>;

function serializeVersion(row: VersionRow, files: FileRow[] | undefined): ArtifactVersion {
	const version: ArtifactVersion = {
		version: row.version,
		filename: row.filename,
		content_type: row.content_type,
		size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
		file_count: files ? files.length : null,
		url: row.url,
		title: row.title,
		pr_repo_url: row.pr_repo_url,
		pr_number: row.pr_number === null ? null : Number(row.pr_number),
		reaffirmed_from: row.reaffirmed_from === null ? null : Number(row.reaffirmed_from),
		actor: actorOf({ ...row, actor_user_id: row.actor_user_id ?? '' }),
		created_at: row.created_at
	};
	if (files) {
		version.files = files.map((f): ArtifactVersionFile => ({
			path: f.path,
			content_type: f.content_type,
			size_bytes: Number(f.size_bytes)
		}));
	}
	return version;
}

function serializeArtifact(
	item: ItemRow,
	versions: VersionRow[],
	filesByVersion: FilesByVersion,
	issue: IssueRef
): Artifact {
	const current = versions[versions.length - 1];
	const serialized = serializeVersion(current, filesByVersion.get(current.id));
	return {
		id: item.id,
		name: item.name,
		artifact_type: artifactTypeOf(item.config),
		description: item.description,
		issue_id: issue.id,
		version_count: versions.length,
		current_version: serialized,
		fresh: serialized.created_at >= issue.stateEnteredAt,
		created_at: item.created_at,
		updated_at: item.updated_at
	};
}

// Ordering survives `idChunks`: every id lands in exactly one chunk, and
// the per-item/per-version sort is re-applied after re-assembly.

async function loadVersions(
	db: Kysely<Database>,
	itemIds: string[]
): Promise<{ byItem: Map<string, VersionRow[]>; filesByVersion: FilesByVersion }> {
	const byItem = new Map<string, VersionRow[]>();
	const filesByVersion: FilesByVersion = new Map();
	if (itemIds.length === 0) return { byItem, filesByVersion };
	const rows = (
		await Promise.all(
			idChunks(itemIds).map((chunk) =>
				versionQuery(db)
					.where('artifact_version.context_item_id', 'in', chunk)
					.orderBy('artifact_version.version asc')
					.execute()
			)
		)
	).flat();
	for (const row of rows) {
		const list = byItem.get(row.context_item_id) ?? [];
		list.push(row);
		byItem.set(row.context_item_id, list);
	}
	if (rows.length > 0) {
		const fileRows = (
			await Promise.all(
				idChunks(rows.map((r) => r.id)).map((chunk) =>
					db
						.selectFrom('artifact_version_file')
						.selectAll()
						.where('artifact_version_id', 'in', chunk)
						.orderBy('path asc')
						.execute()
				)
			)
		).flat();
		for (const file of fileRows) {
			const list = filesByVersion.get(file.artifact_version_id) ?? [];
			list.push(file);
			filesByVersion.set(file.artifact_version_id, list);
		}
	}
	return { byItem, filesByVersion };
}

/** One artifact version on an issue, with its item's name and its file list. */
export interface IssueArtifactVersion {
	item_id: string;
	name: string;
	artifact_type: ArtifactType;
	version: number;
	actor_run_id: string | null;
	actor_run_issue_id: string | null;
	pr_repo_url: string | null;
	pr_number: number | null;
	created_at: number;
	/** folder versions: the snapshot's paths, sorted; empty for other types. */
	files: string[];
}

/**
 * Every version of every artifact on one issue, oldest first. The handoff
 * derivations need the whole history (they compare `from_version` against what
 * preceded a run), so this deliberately does not collapse to current versions.
 */
export async function loadIssueVersions(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<IssueArtifactVersion[]> {
	const rows = await versionQuery(db)
		.innerJoin('context_item', 'context_item.id', 'artifact_version.context_item_id')
		.select(['context_item.name as item_name', 'context_item.config as item_config'])
		.where('context_item.user_id', '=', userId)
		.where('context_item.kind', '=', 'artifact')
		.where('context_item.issue_id', '=', issueId)
		.orderBy('artifact_version.created_at asc')
		.orderBy('artifact_version.version asc')
		.execute();
	const filesByVersion = new Map<string, string[]>();
	if (rows.length > 0) {
		const fileRows = (
			await Promise.all(
				idChunks(rows.map((r) => r.id)).map((chunk) =>
					db
						.selectFrom('artifact_version_file')
						.select(['artifact_version_id', 'path'])
						.where('artifact_version_id', 'in', chunk)
						.orderBy('path asc')
						.execute()
				)
			)
		).flat();
		for (const f of fileRows) {
			const list = filesByVersion.get(f.artifact_version_id) ?? [];
			list.push(f.path);
			filesByVersion.set(f.artifact_version_id, list);
		}
	}
	return rows.map((r) => ({
		item_id: r.context_item_id,
		name: r.item_name,
		artifact_type: artifactTypeOf(r.item_config),
		version: r.version,
		actor_run_id: r.actor_run_id,
		actor_run_issue_id: r.actor_run_issue_id,
		pr_repo_url: r.pr_repo_url,
		pr_number: r.pr_number,
		created_at: r.created_at,
		files: filesByVersion.get(r.id) ?? []
	}));
}

/** Every artifact on an issue, current-version summarized, `fresh` computed. */
export async function listArtifacts(
	db: Kysely<Database>,
	userId: string,
	issueId: string
): Promise<Artifact[]> {
	const issue = await requireIssue(db, userId, issueId);
	const items = await itemQuery(db, userId, issue.id)
		.orderBy('created_at asc')
		.orderBy('id asc')
		.execute();
	const { byItem, filesByVersion } = await loadVersions(
		db,
		items.map((i) => i.id)
	);
	return items
		.filter((i) => (byItem.get(i.id) ?? []).length > 0)
		.map((i) => serializeArtifact(i, byItem.get(i.id)!, filesByVersion, issue));
}

interface LoadedArtifact {
	item: ItemRow;
	versions: VersionRow[];
	filesByVersion: FilesByVersion;
}

async function requireArtifact(
	db: Kysely<Database>,
	userId: string,
	issue: IssueRef,
	name: string
): Promise<LoadedArtifact> {
	const item = await itemQuery(db, userId, issue.id).where('name', '=', name).executeTakeFirst();
	if (!item) throw notFound();
	const { byItem, filesByVersion } = await loadVersions(db, [item.id]);
	const versions = byItem.get(item.id) ?? [];
	if (versions.length === 0) throw notFound();
	return { item, versions, filesByVersion };
}

export async function getArtifactDetail(
	db: Kysely<Database>,
	userId: string,
	issueId: string,
	name: string
): Promise<ArtifactDetail> {
	const issue = await requireIssue(db, userId, issueId);
	const { item, versions, filesByVersion } = await requireArtifact(db, userId, issue, name);
	return {
		...serializeArtifact(item, versions, filesByVersion, issue),
		versions: versions.map((v) => serializeVersion(v, filesByVersion.get(v.id)))
	};
}

// ---------------------------------------------------------------------------
// Requirement checking (shared by transition enforcement, the issue read's
// pre-flight `requires`, and the launch prompt)

export function checkRequirements(
	requires: ArtifactRequirement[],
	artifacts: Pick<Artifact, 'name' | 'artifact_type' | 'fresh' | 'current_version'>[],
	ref: string
): ArtifactRequirementCheck[] {
	return requires.map((r) => {
		const artifact = artifacts.find((a) => a.name === r.artifact);
		let status: ArtifactRequirementStatus;
		if (!artifact) {
			status = 'missing';
		} else if (
			(r.type !== undefined && artifact.artifact_type !== r.type) ||
			(r.content_type !== undefined &&
				!(artifact.current_version.content_type ?? '').startsWith(r.content_type))
		) {
			status = 'type_mismatch';
		} else if (!artifact.fresh) {
			status = 'stale';
		} else {
			status = 'satisfied';
		}
		const checked = {
			...r,
			status,
			current_version: artifact
				? {
						version: artifact.current_version.version,
						created_at: artifact.current_version.created_at
					}
				: null,
			current_type: artifact ? artifact.artifact_type : null
		};
		// The fix is computed here and nowhere else: the 422, the issue read
		// and the launch prompt all read it off the check.
		return { ...checked, fix: requirementFix(checked, ref).command };
	});
}

/** One-line "(file, text/markdown)" spec rendering for messages and prompts. */
export function requirementSpecLabel(r: ArtifactRequirement): string {
	const parts = [r.type, r.content_type].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

// ---------------------------------------------------------------------------
// Payload validation per type

interface VersionPayload {
	filename: string | null;
	content_type: string | null;
	size_bytes: number | null;
	r2_key: string | null;
	content: string | null;
	url: string | null;
	title: string | null;
	pr_repo_url: string | null;
	pr_number: number | null;
}

const emptyPayload: VersionPayload = {
	filename: null,
	content_type: null,
	size_bytes: null,
	r2_key: null,
	content: null,
	url: null,
	title: null,
	pr_repo_url: null,
	pr_number: null
};

function textPayload(name: string, body: UpsertArtifactRequest): VersionPayload {
	if (typeof body.content !== 'string' || body.content.length === 0) {
		throw new ApiFail(
			422,
			'invalid_field',
			'A text artifact version needs "content" (the document)',
			{
				field: 'content'
			}
		);
	}
	const bytes = byteLength(body.content);
	if (bytes > ARTIFACT_TEXT_MAX_BYTES) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`A text artifact can be at most ${ARTIFACT_TEXT_MAX_BYTES} bytes of UTF-8 (got ${bytes}); upload it as a file instead`,
			{ field: 'content', max_bytes: ARTIFACT_TEXT_MAX_BYTES, size_bytes: bytes }
		);
	}
	return {
		...emptyPayload,
		content: body.content,
		filename: body.filename !== undefined ? validateFilename(String(body.filename)) : `${name}.md`,
		content_type:
			body.content_type !== undefined
				? validateContentType(String(body.content_type))
				: 'text/markdown'
	};
}

function linkPayload(body: UpsertArtifactRequest): VersionPayload {
	const raw = typeof body.url === 'string' ? body.url.trim() : '';
	let parsed: URL | null = null;
	try {
		parsed = new URL(raw);
	} catch {
		parsed = null;
	}
	if (
		!parsed ||
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		raw.length > 2000
	) {
		throw new ApiFail(
			422,
			'invalid_field',
			'A link artifact needs "url" (http or https, at most 2000 chars)',
			{
				field: 'url'
			}
		);
	}
	return {
		...emptyPayload,
		url: raw,
		title: optionalString(body.title, 'title', { max: 500 })?.trim() || null
	};
}

function prPayload(body: UpsertArtifactRequest): VersionPayload {
	if (body.pr_url !== undefined) {
		if (body.pr_repo_url !== undefined || body.pr_number !== undefined) {
			throw new ApiFail(
				422,
				'invalid_field',
				'Pass "pr_url" or the split "pr_repo_url" + "pr_number", not both'
			);
		}
		const parsed = typeof body.pr_url === 'string' ? parsePrSpec(body.pr_url) : null;
		if (!parsed) {
			throw new ApiFail(
				422,
				'invalid_field',
				`"pr_url" must be a GitHub pull request URL (https://github.com/{owner}/{repo}/pull/{n}); got ${JSON.stringify(body.pr_url)}`,
				{ field: 'pr_url' }
			);
		}
		return { ...emptyPayload, pr_repo_url: parsed.repo_url, pr_number: parsed.number };
	}
	const repoUrl =
		typeof body.pr_repo_url === 'string' ? canonicalGitHubRepoUrl(body.pr_repo_url) : null;
	if (!repoUrl) {
		throw new ApiFail(
			422,
			'invalid_field',
			'A pr artifact needs "pr_url", or "pr_repo_url" (a github.com repository URL) with "pr_number"',
			{ field: 'pr_repo_url' }
		);
	}
	if (
		typeof body.pr_number !== 'number' ||
		!Number.isInteger(body.pr_number) ||
		body.pr_number < 1
	) {
		throw new ApiFail(422, 'invalid_field', '"pr_number" must be a positive integer', {
			field: 'pr_number'
		});
	}
	return { ...emptyPayload, pr_repo_url: repoUrl, pr_number: body.pr_number };
}

// ---------------------------------------------------------------------------
// Writes

const VERSION_RACE_RETRIES = 3;

/** The constraint violation a lost `version = last + 1` race raises. */
function isUniqueConstraintViolation(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /UNIQUE constraint/i.test(message) || /SQLITE_CONSTRAINT/i.test(message);
}

/**
 * Concurrent attaches to the same name race on `version = last + 1`: the
 * loser's batch hits UNIQUE(context_item_id, version). Re-running the write
 * re-reads the history and takes the next free slot, so a concurrent attach
 * loses nothing (per the spec) instead of surfacing a raw constraint 500.
 * A retried upload re-puts its object under a fresh version id; the failed
 * attempt's object is an invisible orphan, the already-accepted failure
 * mode. A race that outlasts the retries becomes a structured 409.
 */
async function retryVersionRace<T>(write: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await write();
		} catch (err) {
			if (err instanceof ApiFail || !isUniqueConstraintViolation(err)) throw err;
			if (attempt >= VERSION_RACE_RETRIES) {
				throw new ApiFail(
					409,
					'conflict',
					'Concurrent writes kept appending to this artifact while this one was in flight; retry'
				);
			}
		}
	}
}

function scopeEventPayload(issue: IssueRef) {
	return {
		project_id: null,
		workflow_state_id: null,
		issue_id: issue.id,
		label: `issue ${issue.projectName}/${issue.number}`
	};
}

function assertVersionCap(versionCount: number, name: string): void {
	if (versionCount >= ARTIFACT_MAX_VERSIONS) {
		throw new ApiFail(
			422,
			'artifact_version_limit',
			`Artifact "${name}" already has ${versionCount} versions (the cap is ${ARTIFACT_MAX_VERSIONS}); delete the artifact if its history is disposable`,
			{ max_versions: ARTIFACT_MAX_VERSIONS }
		);
	}
}

/** A folder entry to write with a version (id/keys already assigned). */
interface NewFileRow {
	id: string;
	path: string;
	content_type: string;
	size_bytes: number;
	r2_key: string;
}

function fileRowInserts(
	db: Kysely<Database>,
	versionId: string,
	fileRows: NewFileRow[]
): CompiledQuery[] {
	return fileRows.map((f) =>
		db
			.insertInto('artifact_version_file')
			.values({ ...f, artifact_version_id: versionId })
			.compile()
	);
}

interface AppendInput {
	item: ItemRow;
	versions: VersionRow[];
	payload: VersionPayload;
	/** Folder versions: the snapshot's entries. */
	fileRows?: NewFileRow[];
	description?: string;
	reaffirmedFrom?: number;
}

/** Queries appending the next version (plus its event) to an existing artifact. */
function appendVersionQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	issue: IssueRef,
	input: AppendInput,
	versionId: string,
	now: number
): { queries: CompiledQuery[]; version: number } {
	assertVersionCap(input.versions.length, input.item.name);
	const version = input.versions[input.versions.length - 1].version + 1;
	const type = artifactTypeOf(input.item.config);
	const eventPayload: Record<string, unknown> = {
		context_id: input.item.id,
		kind: 'artifact',
		name: input.item.name,
		artifact_type: type,
		version,
		scope: scopeEventPayload(issue)
	};
	if (input.reaffirmedFrom !== undefined) eventPayload.reaffirmed_from = input.reaffirmedFrom;
	else {
		if (input.payload.filename) eventPayload.filename = input.payload.filename;
		if (input.payload.size_bytes !== null) eventPayload.size_bytes = input.payload.size_bytes;
	}
	if (input.fileRows) eventPayload.file_count = input.fileRows.length;
	const queries: CompiledQuery[] = [
		db
			.insertInto('artifact_version')
			.values({
				id: versionId,
				context_item_id: input.item.id,
				version,
				...input.payload,
				reaffirmed_from: input.reaffirmedFrom ?? null,
				actor_user_id: actor.userId,
				actor_api_key_id: actor.apiKeyId,
				created_at: now
			})
			.compile(),
		...fileRowInserts(db, versionId, input.fileRows ?? []),
		db
			.updateTable('context_item')
			.set({
				...(input.description !== undefined ? { description: input.description } : {}),
				updated_at: now
			})
			.where('id', '=', input.item.id)
			.compile(),
		eventInsert(db, actor, {
			type: 'context.updated',
			issueId: issue.id,
			projectId: issue.projectId,
			payload: eventPayload
		})
	];
	return { queries, version };
}

/** Queries creating a brand-new artifact with its v1 (plus the event). */
function createArtifactQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	issue: IssueRef,
	input: {
		name: string;
		type: ArtifactType;
		description: string;
		payload: VersionPayload;
		fileRows?: NewFileRow[];
	},
	itemId: string,
	versionId: string,
	now: number
): CompiledQuery[] {
	return [
		db
			.insertInto('context_item')
			.values({
				id: itemId,
				user_id: actor.userId,
				kind: 'artifact',
				name: input.name,
				description: input.description,
				project_id: null,
				workflow_state_id: null,
				issue_id: issue.id,
				body: null,
				repo_url: null,
				repo_branch: null,
				repo_dir: null,
				config: JSON.stringify({ artifact_type: input.type }),
				position: 0,
				version: 1,
				created_at: now,
				updated_at: now
			})
			.compile(),
		db
			.insertInto('artifact_version')
			.values({
				id: versionId,
				context_item_id: itemId,
				version: 1,
				...input.payload,
				reaffirmed_from: null,
				actor_user_id: actor.userId,
				actor_api_key_id: actor.apiKeyId,
				created_at: now
			})
			.compile(),
		...fileRowInserts(db, versionId, input.fileRows ?? []),
		eventInsert(db, actor, {
			type: 'context.created',
			issueId: issue.id,
			projectId: issue.projectId,
			payload: {
				context_id: itemId,
				kind: 'artifact',
				name: input.name,
				artifact_type: input.type,
				version: 1,
				...(input.payload.filename ? { filename: input.payload.filename } : {}),
				...(input.payload.size_bytes !== null ? { size_bytes: input.payload.size_bytes } : {}),
				...(input.fileRows ? { file_count: input.fileRows.length } : {}),
				scope: scopeEventPayload(issue)
			}
		})
	];
}

async function loadCurrent(
	db: Kysely<Database>,
	userId: string,
	issue: IssueRef,
	name: string
): Promise<LoadedArtifact | null> {
	const item = await itemQuery(db, userId, issue.id).where('name', '=', name).executeTakeFirst();
	if (!item) return null;
	const { byItem, filesByVersion } = await loadVersions(db, [item.id]);
	const versions = byItem.get(item.id) ?? [];
	return versions.length > 0 ? { item, versions, filesByVersion } : null;
}

function typeMismatch(name: string, existing: ArtifactType, requested: ArtifactType): ApiFail {
	return new ApiFail(
		422,
		'artifact_type_mismatch',
		`Artifact "${name}" is of type "${existing}"; the type is immutable — attach as a different name, or delete the artifact first (requested "${requested}")`,
		{ field: 'type', existing_type: existing, requested_type: requested }
	);
}

/**
 * The JSON upsert (`PUT …/artifacts/:name`): creates a text/link/pr artifact
 * or appends a version to it. A body with no payload fields is a
 * metadata-only update and does not create a version.
 */
export function upsertArtifact(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	body: UpsertArtifactRequest
): Promise<Artifact> {
	return retryVersionRace(() => upsertArtifactOnce(db, env, actor, issueId, rawName, body));
}

async function upsertArtifactOnce(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	body: UpsertArtifactRequest
): Promise<Artifact> {
	const issue = await requireIssue(db, actor.userId, issueId);
	await assertWritable(db, actor, artifactProject(issue), { issueId: issue.id });
	const name = validateArtifactName(rawName);
	const description = optionalString(body.description, 'description', { max: 1000 });
	const existing = await loadCurrent(db, actor.userId, issue, name);
	const fields = payloadFieldsPresent(body as unknown as Record<string, unknown>);

	if (!existing) {
		const type = requireArtifactType(body.type);
		if (type === 'file') {
			throw new ApiFail(
				422,
				'use_file_endpoint',
				`File artifacts are created by uploading bytes: PUT …/artifacts/${name}/file?filename=… with the file as the request body`,
				{ field: 'type' }
			);
		}
		if (type === 'folder') {
			throw new ApiFail(
				422,
				'use_folder_endpoint',
				`Folder artifacts are created by uploading a snapshot: PUT …/artifacts/${name}/folder with one multipart part per file`,
				{ field: 'type' }
			);
		}
		rejectForeignPayload(type, body as unknown as Record<string, unknown>);
		if (fields.length === 0) {
			throw new ApiFail(
				422,
				'invalid_field',
				`Creating artifact "${name}" needs its first version's payload (${TYPE_FIELDS[type].join(', ')})`,
				{ field: 'type' }
			);
		}
		const payload =
			type === 'text'
				? textPayload(name, body)
				: type === 'link'
					? linkPayload(body)
					: prPayload(body);
		const itemId = newId('ctx');
		const now = Date.now();
		await runAtomic(
			env,
			createArtifactQueries(
				db,
				actor,
				issue,
				{ name, type, description: description ?? '', payload },
				itemId,
				newId('av'),
				now
			)
		);
		return getArtifact(db, actor.userId, issue, name);
	}

	const type = artifactTypeOf(existing.item.config);
	if (body.type !== undefined && requireArtifactType(body.type) !== type) {
		throw typeMismatch(name, type, requireArtifactType(body.type));
	}
	if (fields.length === 0) {
		// Metadata-only: no version, no freshness change.
		if (description !== undefined && description !== existing.item.description) {
			await runAtomic(env, [
				db
					.updateTable('context_item')
					.set({ description, updated_at: Date.now() })
					.where('id', '=', existing.item.id)
					.compile(),
				eventInsert(db, actor, {
					type: 'context.updated',
					issueId: issue.id,
					projectId: issue.projectId,
					payload: {
						context_id: existing.item.id,
						kind: 'artifact',
						name,
						artifact_type: type,
						changed: ['description'],
						scope: scopeEventPayload(issue)
					}
				})
			]);
		}
		return getArtifact(db, actor.userId, issue, name);
	}
	if (type === 'file') {
		throw new ApiFail(
			422,
			'use_file_endpoint',
			`Artifact "${name}" is a file; attach a new version by uploading bytes: PUT …/artifacts/${name}/file?filename=…`,
			{ existing_type: type }
		);
	}
	if (type === 'folder') {
		throw new ApiFail(
			422,
			'use_folder_endpoint',
			`Artifact "${name}" is a folder; attach a new snapshot: PUT …/artifacts/${name}/folder with one multipart part per file`,
			{ existing_type: type }
		);
	}
	rejectForeignPayload(type, body as unknown as Record<string, unknown>);
	const payload =
		type === 'text'
			? textPayload(name, body)
			: type === 'link'
				? linkPayload(body)
				: prPayload(body);
	const { queries } = appendVersionQueries(
		db,
		actor,
		issue,
		{ item: existing.item, versions: existing.versions, payload, description },
		newId('av'),
		Date.now()
	);
	await runAtomic(env, queries);
	return getArtifact(db, actor.userId, issue, name);
}

/**
 * The raw-body upload (`PUT …/artifacts/:name/file`): R2 object first, then
 * the D1 batch — a failed batch orphans an invisible object, never the
 * reverse (no row may reference a missing object).
 */
export function uploadArtifactFile(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	file: { filename: string; contentType: string; bytes: Uint8Array }
): Promise<Artifact> {
	return retryVersionRace(() => uploadArtifactFileOnce(db, env, actor, issueId, rawName, file));
}

async function uploadArtifactFileOnce(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	file: { filename: string; contentType: string; bytes: Uint8Array }
): Promise<Artifact> {
	const issue = await requireIssue(db, actor.userId, issueId);
	await assertWritable(db, actor, artifactProject(issue), { issueId: issue.id });
	const name = validateArtifactName(rawName);
	const filename = validateFilename(file.filename);
	const contentType = validateContentType(file.contentType);
	if (file.bytes.byteLength > ARTIFACT_FILE_MAX_BYTES) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`An artifact file can be at most ${ARTIFACT_FILE_MAX_BYTES} bytes (got ${file.bytes.byteLength})`,
			{ max_bytes: ARTIFACT_FILE_MAX_BYTES, size_bytes: file.bytes.byteLength }
		);
	}

	const existing = await loadCurrent(db, actor.userId, issue, name);
	if (existing && artifactTypeOf(existing.item.config) !== 'file') {
		throw typeMismatch(name, artifactTypeOf(existing.item.config), 'file');
	}
	if (existing) assertVersionCap(existing.versions.length, name);

	const itemId = existing?.item.id ?? newId('ctx');
	const versionId = newId('av');
	const now = Date.now();
	const key = artifactKey(actor.userId, itemId, versionId);
	const payload: VersionPayload = {
		...emptyPayload,
		filename,
		content_type: contentType,
		size_bytes: file.bytes.byteLength,
		r2_key: key
	};
	// Write order per the spec: object first, then the batch.
	await getArtifactStore(env).put(key, file.bytes);
	const queries = existing
		? appendVersionQueries(
				db,
				actor,
				issue,
				{ item: existing.item, versions: existing.versions, payload },
				versionId,
				now
			).queries
		: createArtifactQueries(
				db,
				actor,
				issue,
				{ name, type: 'file', description: '', payload },
				itemId,
				versionId,
				now
			);
	await runAtomic(env, queries);
	return getArtifact(db, actor.userId, issue, name);
}

export interface FolderUploadFile {
	path: string;
	contentType: string;
	bytes: Uint8Array;
}

/**
 * The multipart snapshot upload (`PUT …/artifacts/:name/folder`): every file
 * of the new version in one request — a folder version is always born whole
 * (the agent collects locally and attaches once; see the spec's Non-goals).
 * Same object-then-batch write order as file uploads, pluralized.
 */
export function uploadArtifactFolder(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	files: FolderUploadFile[]
): Promise<Artifact> {
	return retryVersionRace(() => uploadArtifactFolderOnce(db, env, actor, issueId, rawName, files));
}

async function uploadArtifactFolderOnce(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	rawName: string,
	files: FolderUploadFile[]
): Promise<Artifact> {
	const issue = await requireIssue(db, actor.userId, issueId);
	await assertWritable(db, actor, artifactProject(issue), { issueId: issue.id });
	const name = validateArtifactName(rawName);
	if (files.length === 0) {
		throw new ApiFail(422, 'invalid_field', 'A folder snapshot needs at least one file part', {
			field: 'files'
		});
	}
	if (files.length > ARTIFACT_FOLDER_MAX_FILES) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`A folder version can hold at most ${ARTIFACT_FOLDER_MAX_FILES} files (got ${files.length})`,
			{ max_files: ARTIFACT_FOLDER_MAX_FILES, file_count: files.length }
		);
	}
	const seen = new Set<string>();
	let totalBytes = 0;
	const entries = files.map((f) => {
		const path = validateFolderPath(f.path);
		if (seen.has(path)) {
			throw new ApiFail(
				422,
				'duplicate_path',
				`Folder file path "${path}" is listed more than once`,
				{
					path
				}
			);
		}
		seen.add(path);
		if (f.bytes.byteLength > ARTIFACT_FILE_MAX_BYTES) {
			throw new ApiFail(
				422,
				'artifact_too_large',
				`Folder file "${path}" is ${f.bytes.byteLength} bytes; each file can be at most ${ARTIFACT_FILE_MAX_BYTES}`,
				{ path, max_bytes: ARTIFACT_FILE_MAX_BYTES, size_bytes: f.bytes.byteLength }
			);
		}
		totalBytes += f.bytes.byteLength;
		return { path, contentType: validateContentType(f.contentType), bytes: f.bytes };
	});
	if (totalBytes > ARTIFACT_FOLDER_MAX_BYTES) {
		throw new ApiFail(
			422,
			'artifact_too_large',
			`A folder version can total at most ${ARTIFACT_FOLDER_MAX_BYTES} bytes (got ${totalBytes})`,
			{ max_bytes: ARTIFACT_FOLDER_MAX_BYTES, size_bytes: totalBytes }
		);
	}

	const existing = await loadCurrent(db, actor.userId, issue, name);
	if (existing && artifactTypeOf(existing.item.config) !== 'folder') {
		throw typeMismatch(name, artifactTypeOf(existing.item.config), 'folder');
	}
	if (existing) assertVersionCap(existing.versions.length, name);

	const itemId = existing?.item.id ?? newId('ctx');
	const versionId = newId('av');
	const now = Date.now();
	const fileRows: NewFileRow[] = entries.map((entry) => {
		const fileId = newId('avf');
		return {
			id: fileId,
			path: entry.path,
			content_type: entry.contentType,
			size_bytes: entry.bytes.byteLength,
			r2_key: artifactFileKey(actor.userId, itemId, versionId, fileId)
		};
	});
	// Objects first, then the batch: a failure partway leaves invisible
	// orphans, never a version row referencing missing objects.
	const store = getArtifactStore(env);
	for (const [i, row] of fileRows.entries()) {
		await store.put(row.r2_key, entries[i].bytes);
	}
	const payload: VersionPayload = { ...emptyPayload, size_bytes: totalBytes };
	const queries = existing
		? appendVersionQueries(
				db,
				actor,
				issue,
				{ item: existing.item, versions: existing.versions, payload, fileRows },
				versionId,
				now
			).queries
		: createArtifactQueries(
				db,
				actor,
				issue,
				{ name, type: 'folder', description: '', payload, fileRows },
				itemId,
				versionId,
				now
			);
	await runAtomic(env, queries);
	return getArtifact(db, actor.userId, issue, name);
}

/**
 * Reaffirm: "this artifact still stands" — appends a version reusing the
 * current version's payload (same R2 object(s); no bytes move) with a fresh
 * timestamp and the calling actor.
 */
export function reaffirmArtifact(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	name: string
): Promise<Artifact> {
	return retryVersionRace(() => reaffirmArtifactOnce(db, env, actor, issueId, name));
}

async function reaffirmArtifactOnce(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	name: string
): Promise<Artifact> {
	const issue = await requireIssue(db, actor.userId, issueId);
	await assertWritable(db, actor, artifactProject(issue), { issueId: issue.id });
	const { item, versions, filesByVersion } = await requireArtifact(db, actor.userId, issue, name);
	const current = versions[versions.length - 1];
	const payload: VersionPayload = {
		filename: current.filename,
		content_type: current.content_type,
		size_bytes: current.size_bytes === null ? null : Number(current.size_bytes),
		r2_key: current.r2_key,
		content: current.content,
		url: current.url,
		title: current.title,
		pr_repo_url: current.pr_repo_url,
		pr_number: current.pr_number === null ? null : Number(current.pr_number)
	};
	// Folder reaffirms copy the file rows, referencing the same objects
	// (safe: deletion is whole-artifact only, a prefix delete on the item).
	const fileRows = (filesByVersion.get(current.id) ?? []).map((f): NewFileRow => ({
		id: newId('avf'),
		path: f.path,
		content_type: f.content_type,
		size_bytes: Number(f.size_bytes),
		r2_key: f.r2_key
	}));
	const { queries } = appendVersionQueries(
		db,
		actor,
		issue,
		{
			item,
			versions,
			payload,
			...(fileRows.length > 0 ? { fileRows } : {}),
			reaffirmedFrom: current.version
		},
		newId('av'),
		Date.now()
	);
	await runAtomic(env, queries);
	return getArtifact(db, actor.userId, issue, name);
}

async function getArtifact(
	db: Kysely<Database>,
	userId: string,
	issue: IssueRef,
	name: string
): Promise<Artifact> {
	const { item, versions, filesByVersion } = await requireArtifact(db, userId, issue, name);
	return serializeArtifact(item, versions, filesByVersion, issue);
}

export async function deleteArtifact(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueId: string,
	name: string
): Promise<void> {
	const issue = await requireIssue(db, actor.userId, issueId);
	await assertWritable(db, actor, artifactProject(issue), { issueId: issue.id });
	const { item } = await requireArtifact(db, actor.userId, issue, name);
	await runAtomic(env, [
		db
			.deleteFrom('artifact_version_file')
			.where(
				'artifact_version_id',
				'in',
				db.selectFrom('artifact_version').select('id').where('context_item_id', '=', item.id)
			)
			.compile(),
		db.deleteFrom('artifact_version').where('context_item_id', '=', item.id).compile(),
		db.deleteFrom('context_item').where('id', '=', item.id).compile(),
		eventInsert(db, actor, {
			type: 'context.deleted',
			issueId: issue.id,
			projectId: issue.projectId,
			payload: {
				context_id: item.id,
				kind: 'artifact',
				name: item.name,
				artifact_type: artifactTypeOf(item.config),
				scope: scopeEventPayload(issue)
			}
		})
	]);
	// D1 first, then best-effort R2 (the accepted failure mode is an orphaned
	// object, never a row referencing a missing one).
	await getArtifactStore(env)
		.deletePrefix(artifactKeyPrefix(actor.userId, item.id))
		.catch(() => {});
}

// ---------------------------------------------------------------------------
// Content serving (specs/artifacts/SPEC.md "Serving content safely")

/** MIME prefixes allowed to render inline (always sandboxed). */
const INLINE_ALLOWLIST = ['image/', 'application/pdf', 'text/plain', 'text/markdown'];

function sanitizeFilename(value: string | null, fallback: string): string {
	const cleaned = (value ?? '')
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f\x7f"\\;]/g, '_')
		.trim();
	return cleaned || fallback;
}

export async function artifactContentResponse(
	db: Kysely<Database>,
	env: Env,
	userId: string,
	issueId: string,
	name: string,
	opts: { version?: number; inline?: boolean; path?: string } = {}
): Promise<Response> {
	const issue = await requireIssue(db, userId, issueId);
	const { item, versions, filesByVersion } = await requireArtifact(db, userId, issue, name);
	const type = artifactTypeOf(item.config);
	const row =
		opts.version === undefined
			? versions[versions.length - 1]
			: versions.find((v) => v.version === opts.version);
	if (!row) throw notFound();
	if (type === 'link' || type === 'pr') {
		throw new ApiFail(
			422,
			'no_content',
			`Artifact "${name}" is a ${type} — the reference is the payload (${type === 'link' ? row.url : `${row.pr_repo_url}/pull/${row.pr_number}`})`,
			{
				artifact_type: type,
				url: type === 'link' ? row.url : `${row.pr_repo_url}/pull/${row.pr_number}`
			}
		);
	}

	let bytes: Uint8Array;
	let contentType: string;
	let filename: string;
	if (type === 'folder') {
		// Folder versions are addressed per file; without a path the 422
		// lists the version's paths so an agent self-corrects in one round.
		const files = filesByVersion.get(row.id) ?? [];
		if (opts.path === undefined) {
			throw new ApiFail(
				422,
				'folder_path_required',
				`Artifact "${name}" is a folder — pick a file with ?path=… (v${row.version} has ${files.length}: ${files
					.slice(0, 20)
					.map((f) => f.path)
					.join(', ')}${files.length > 20 ? ', …' : ''})`,
				{ artifact_type: type, version: row.version, paths: files.map((f) => f.path) }
			);
		}
		const file = files.find((f) => f.path === opts.path);
		if (!file) throw notFound();
		const object = await getArtifactStore(env).get(file.r2_key);
		if (!object) throw notFound();
		bytes = object;
		contentType = file.content_type;
		filename = sanitizeFilename(file.path.split('/').pop() ?? null, name);
	} else if (type === 'text') {
		bytes = new TextEncoder().encode(row.content ?? '');
		contentType = row.content_type ?? 'application/octet-stream';
		filename = sanitizeFilename(row.filename, name);
	} else {
		const object = row.r2_key ? await getArtifactStore(env).get(row.r2_key) : null;
		if (!object) throw notFound();
		bytes = object;
		contentType = row.content_type ?? 'application/octet-stream';
		filename = sanitizeFilename(row.filename, name);
	}
	const inline = opts.inline === true && INLINE_ALLOWLIST.some((p) => contentType.startsWith(p));
	const headers: Record<string, string> = {
		'content-type': contentType,
		'content-length': String(bytes.byteLength),
		'x-content-type-options': 'nosniff',
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`
	};
	// Inline rendering of user bytes on our origin: the sandbox keeps an SVG
	// or HTML-ish payload from scripting against the app.
	if (inline) headers['content-security-policy'] = 'sandbox';
	return new Response(bytes as unknown as BodyInit, { status: 200, headers });
}
