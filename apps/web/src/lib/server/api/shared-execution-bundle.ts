/**
 * `SharedExecutionBundleV1` (Tines/752): the one coherent projection of a
 * shared project's guidance that every reader and every launch of an issue
 * receives while shared execution is on.
 *
 * The guidance is today's matcher and precedence (`matchingItemsQuery`,
 * `sortMatched`, `assembleEffectiveContext`) filtered by
 * `sharedGuidancePredicate`, read in one D1 batch so it is a snapshot. The
 * batch also selects `bundleWitnessExpr`: the complete ordered revision vector
 * of everything the bundle was built from, recomputed from live tables. A
 * read-only caller re-selects it after assembly and rebuilds on a change; an
 * admitting caller guards its write on `expr = vector` instead. One fragment,
 * three uses.
 */
import type {
	ContextFile,
	EffectiveContext,
	IssueDetail,
	SharedExecutionBundleV1
} from '@tines/shared';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '../db';
import { sha256Hex } from '../crypto';
import { listArtifacts } from './artifacts';
import {
	assembleEffectiveContext,
	journalTarget,
	matchingItemsQuery,
	sharedGuidancePredicate,
	sortMatched,
	stateChainFromRows,
	stateChainQuery,
	winningSkillIds,
	type ItemRow,
	type MatchTarget
} from './context';
import { ApiFail, notFound, runAtomic } from './core';
import { getIssueDetail } from './issues';
import { resolveScope, toContextScope } from './scope';

/** More matched items than this and the bundle refuses rather than truncates. */
export const BUNDLE_ITEM_CAP = 250;
/** Serialized bundle bytes, skill file contents included. */
export const BUNDLE_SIZE_CAP = 1024 * 1024;
/** Snapshot attempts before a read gives up on a churning issue. */
export const BUNDLE_ATTEMPTS = 2;
const LABEL_VOCABULARY_MAX = 40;

export type BundleFailureReason = 'item_cap' | 'size_cap' | 'repo_dir_conflict' | 'churn';

/**
 * Server-only: what the bundle was built from, enough to recompute its
 * revision vector. Never serialized to any client.
 */
export interface BundleWitness {
	vector: string;
	digest: string;
	issueId: string;
	projectId: string;
	ownerId: string;
	/** The issue's state chain, root → leaf, that the guidance matched. */
	stateChain: string[];
	launchStateId: string | null;
	/** The launch state's chain when it anchors the journal, else null. */
	launchChain: string[] | null;
}

export interface LoadBundleOptions {
	issueId: string;
	/** The run's launch state: anchors the journal the way `journalForIssue` does for a run key. */
	launchStateId?: string | null;
	/** False for display: file counts and byte sizes only, no contents. */
	skillFiles: boolean;
	/**
	 * Admission callers skip the read-side validation and guard their write on
	 * the witness instead.
	 */
	validate?: boolean;
	/** Test hook: runs between the snapshot and its validation. */
	beforeValidate?: (attempt: number) => Promise<void>;
}

export function bundleFailure(reason: BundleFailureReason, details: Record<string, unknown> = {}) {
	if (reason === 'item_cap' || reason === 'size_cap')
		return new ApiFail(
			422,
			'bundle_too_large',
			reason === 'item_cap'
				? `This issue matches more than ${BUNDLE_ITEM_CAP} shared guidance items`
				: 'This issue’s shared guidance is larger than 1 MiB',
			{ reason, ...details }
		);
	return new ApiFail(
		409,
		'bundle_unavailable',
		reason === 'churn'
			? 'Shared guidance kept changing while it was assembled; try again shortly'
			: 'Two shared repos check out into the same directory',
		{ reason, ...details }
	);
}

/** Plain-language reason for a bundle failure, for inline display. */
export function bundleFailureText(e: ApiFail): string {
	switch (e.details?.reason) {
		case 'item_cap':
			return `it matches more than ${BUNDLE_ITEM_CAP} items`;
		case 'size_cap':
			return 'it is larger than 1 MiB';
		case 'repo_dir_conflict':
			return `two repos check out into the same directory (${((e.details?.dirs as string[]) ?? []).join(', ')})`;
		default:
			return 'it kept changing while it was read';
	}
}

/** The shared projection of the owner's matching items for one target. */
function sharedItemsQuery(db: Kysely<Database>, ownerId: string, target: MatchTarget) {
	return matchingItemsQuery(db, ownerId, target).where(
		sharedGuidancePredicate(target.projectId, target.issueId)
	);
}

/**
 * The complete ordered revision vector of a bundle, as one scalar SQL
 * expression over live tables: the issue target, its state chain(s), its
 * labels, every projected item (with its skill files' count / bytes /
 * high-water), the project's inclusion rows and the issue-block inputs.
 * Matching is recomputed, so a newly matching item changes it as surely as an
 * edited one. Compare with `= :vector` to guard a write.
 */
export function bundleWitnessExpr(
	db: Kysely<Database>,
	w: Omit<BundleWitness, 'vector' | 'digest'>
): RawBuilder<string> {
	const target: MatchTarget = {
		projectId: w.projectId,
		stateChain: w.stateChain,
		issueId: w.issueId
	};
	const chainIds = [...new Set([...w.stateChain, ...(w.launchChain ?? [])])];
	const t = db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.where('issue.id', '=', w.issueId)
		.select(
			sql<string>`'t:' || issue.project_id || ',' || issue.state_id || ',' || issue.workflow_id
				|| ',' || issue.project_assignment_token || ',' || issue.updated_at
				|| ',' || issue.decision_revision || ',' || project.user_id || ',' || project.name
				|| ',' || coalesce(project.shared_at, '') || ',' || ${w.launchStateId ?? ''}`.as('v')
		);
	const s = db
		.selectFrom('workflow_state')
		.where('workflow_state.id', 'in', chainIds)
		.select(
			sql<string>`'s:' || workflow_state.id || ',' || workflow_state.name
				|| ',' || coalesce(workflow_state.inherits_from_state_id, '')`.as('v')
		);
	const l = db
		.selectFrom('issue_label')
		.leftJoin('label', 'label.id', 'issue_label.label_id')
		.where('issue_label.issue_id', '=', w.issueId)
		.select(sql<string>`'l:' || issue_label.label_id || ',' || coalesce(label.name, '')`.as('v'));
	const c = sharedItemsQuery(db, w.ownerId, target)
		.clearSelect()
		.select(
			sql<string>`'c:' || context_item.id || ',' || context_item.version || ',' || context_item.kind
				|| ',' || context_item.name || ',' || coalesce(context_item.project_id, '')
				|| ',' || coalesce(context_item.workflow_state_id, '')
				|| ',' || coalesce(context_item.label_id, '') || ',' || coalesce(context_item.issue_id, '')
				|| ',' || context_item.position || ',' || context_item.updated_at
				|| ',' || (SELECT count(*) || ',' || total(length(CAST(f.content AS BLOB)))
					|| ',' || coalesce(max(f.updated_at), '')
					FROM context_item_file f WHERE f.context_item_id = context_item.id)`.as('v')
		);
	const n = db
		.selectFrom('project_guidance_inclusion')
		.where('project_guidance_inclusion.project_id', '=', w.projectId)
		.select(
			sql<string>`'n:' || project_guidance_inclusion.context_item_id
				|| ',' || project_guidance_inclusion.revision`.as('v')
		);
	const m = db
		.selectFrom('issue')
		.where('issue.id', '=', w.issueId)
		.select(
			sql<string>`'m:' || (SELECT count(*) || ',' || coalesce(max(coalesce(cm.updated_at, cm.created_at)), '')
					FROM comment cm WHERE cm.issue_id = issue.id)
				|| ',' || (SELECT count(av.id) || ',' || coalesce(max(av.version), '')
					|| ',' || count(DISTINCT ci.id) || ',' || coalesce(max(ci.updated_at), '')
					FROM context_item ci LEFT JOIN artifact_version av ON av.context_item_id = ci.id
					WHERE ci.issue_id = issue.id AND ci.kind = 'artifact')
				|| ',' || (SELECT count(*) FROM issue_link il
					WHERE il.source_issue_id = issue.id OR il.target_issue_id = issue.id)`.as('v')
		);
	const vector = db
		.selectFrom(t.unionAll(s).unionAll(l).unionAll(c).unionAll(n).unionAll(m).as('u'))
		.select('u.v')
		.orderBy('u.v');
	return sql<string>`(SELECT coalesce(group_concat(o.v, '|'), '') FROM ${vector.as('o')})`;
}

interface TargetRow {
	project_id: string;
	state_id: string;
	workflow_id: string;
	project_name: string;
	owner_id: string;
	owner_name: string;
	shared_at: number | null;
}

function targetQuery(db: Kysely<Database>, issueId: string) {
	return db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.innerJoin('user', 'user.id', 'project.user_id')
		.where('issue.id', '=', issueId)
		.select([
			'issue.project_id',
			'issue.state_id',
			'issue.workflow_id',
			'project.name as project_name',
			'project.user_id as owner_id',
			'user.name as owner_name',
			'project.shared_at'
		]);
}

const sameTarget = (a: TargetRow, b: TargetRow) =>
	a.project_id === b.project_id &&
	a.state_id === b.state_id &&
	a.workflow_id === b.workflow_id &&
	a.owner_id === b.owner_id &&
	(a.shared_at === null) === (b.shared_at === null);

const sameChain = (a: string[], b: string[]) =>
	a.length === b.length && a.every((id, i) => id === b[i]);

interface Snapshot {
	target: TargetRow;
	match: MatchTarget;
	rows: ItemRow[];
	files: Map<string, ContextFile[]>;
	fileBytes: number;
	labels: { id: string; name: string | null }[];
	witness: BundleWitness;
}

/**
 * One snapshot attempt. The target and chains are read first to parameterize
 * the batch; the batch re-reads both, so a move between the two reads is
 * caught here and costs an attempt rather than yielding a mixed snapshot.
 */
async function snapshot(
	env: Env,
	db: Kysely<Database>,
	opts: LoadBundleOptions
): Promise<Snapshot | 'moved'> {
	const pre = await targetQuery(db, opts.issueId).executeTakeFirst();
	if (!pre || pre.shared_at === null) throw notFound();
	const launchStateId = opts.launchStateId ?? null;
	const [stateChain, launchChain] = await Promise.all([
		stateChainQuery(db, pre.state_id)
			.execute()
			.then((r) => stateChainFromRows(r, pre.state_id)),
		launchStateId
			? stateChainQuery(db, launchStateId)
					.execute()
					.then((r) => stateChainFromRows(r, launchStateId))
			: null
	]);
	const match: MatchTarget = { projectId: pre.project_id, stateChain, issueId: opts.issueId };
	const base = {
		issueId: opts.issueId,
		projectId: pre.project_id,
		ownerId: pre.owner_id,
		stateChain,
		launchStateId,
		launchChain
	};
	const items = sharedItemsQuery(db, pre.owner_id, match);
	const results = await runAtomic(env, [
		targetQuery(db, opts.issueId).select(bundleWitnessExpr(db, base).as('vector')).compile(),
		stateChainQuery(db, pre.state_id).compile(),
		items.compile(),
		db
			.selectFrom('context_item_file')
			.where(
				'context_item_file.context_item_id',
				'in',
				items.where('context_item.kind', '=', 'skill').clearSelect().select('context_item.id')
			)
			.select([
				'context_item_file.context_item_id',
				'context_item_file.path',
				opts.skillFiles ? 'context_item_file.content' : sql<string>`''`.as('content'),
				sql<number>`length(CAST(context_item_file.content AS BLOB))`.as('bytes')
			])
			.orderBy('context_item_file.context_item_id')
			.orderBy('context_item_file.path')
			.compile(),
		db
			.selectFrom('issue_label')
			.leftJoin('label', 'label.id', 'issue_label.label_id')
			.where('issue_label.issue_id', '=', opts.issueId)
			.select(['issue_label.label_id as id', 'label.name'])
			.orderBy('issue_label.label_id')
			.compile()
	]);
	const rowsOf = <T>(i: number) => (results[i]?.results ?? []) as T[];
	const now = rowsOf<TargetRow & { vector: string }>(0)[0];
	if (!now || now.shared_at === null) throw notFound();
	const chainNow = stateChainFromRows(rowsOf<{ id: string; depth: number }>(1), now.state_id);
	if (!sameTarget(pre, now) || !sameChain(stateChain, chainNow)) return 'moved';

	const rows = sortMatched(rowsOf<ItemRow>(2), stateChain);
	const winners = new Set(winningSkillIds(rows));
	const files = new Map<string, ContextFile[]>();
	let fileBytes = 0;
	for (const f of rowsOf<{ context_item_id: string; path: string; content: string; bytes: number }>(
		3
	)) {
		if (!winners.has(f.context_item_id)) continue;
		fileBytes += Number(f.bytes ?? 0);
		if (!opts.skillFiles) continue;
		const list = files.get(f.context_item_id) ?? [];
		list.push({ path: f.path, content: f.content });
		files.set(f.context_item_id, list);
	}
	return {
		target: now,
		match,
		rows,
		files,
		fileBytes,
		labels: rowsOf<{ id: string; name: string | null }>(4),
		witness: { ...base, vector: now.vector, digest: await sha256Hex(now.vector) }
	};
}

/**
 * The issue detail every reader sees in a shared bundle: the owner-scoped
 * read with links into other projects dropped and the context summary counted
 * from the projection, so owner and member receive the same inputs.
 */
async function sharedIssueDetail(
	db: Kysely<Database>,
	ownerId: string,
	projectId: string,
	issueId: string,
	guidance: EffectiveContext,
	artifactCount: number
): Promise<IssueDetail> {
	const detail = await getIssueDetail(
		db,
		ownerId,
		{ id: issueId },
		{ round: true, launchComments: true }
	);
	const links = detail.links;
	const linked = [
		...links.blocked_by,
		...links.blocks,
		...(links.duplicate_of ? [links.duplicate_of] : []),
		...links.duplicated_by
	];
	const local = new Set(
		linked.length
			? (
					await db
						.selectFrom('issue')
						.select('id')
						.where(
							'id',
							'in',
							linked.map((l) => l.issue_id)
						)
						.where('project_id', '=', projectId)
						.execute()
				).map((r) => r.id)
			: []
	);
	const keep = <T extends { issue_id: string }>(l: T) => local.has(l.issue_id);
	const redacted = [...(detail.redacted ?? [])];
	if (local.size !== linked.length && !redacted.includes('project_links'))
		redacted.push('project_links');
	return {
		...detail,
		links: {
			blocked_by: links.blocked_by.filter(keep),
			blocks: links.blocks.filter(keep),
			duplicate_of: links.duplicate_of && keep(links.duplicate_of) ? links.duplicate_of : null,
			duplicated_by: links.duplicated_by.filter(keep)
		},
		context_summary: {
			prompts: guidance.prompt.parts.length,
			skills: guidance.skills.length,
			repos: guidance.repos.length,
			artifacts: artifactCount,
			envs: 0
		},
		...(redacted.length ? { redacted } : {})
	};
}

/** Labels on this project's issues or on matched items — never the owner's whole library. */
async function labelVocabulary(
	db: Kysely<Database>,
	ownerId: string,
	projectId: string,
	rows: ItemRow[]
): Promise<string[]> {
	const matched = [...new Set(rows.map((r) => r.label_id).filter((id): id is string => !!id))];
	const labels = await db
		.selectFrom('label')
		.select('name')
		.where('user_id', '=', ownerId)
		.where((eb) =>
			eb.or([
				eb(
					'id',
					'in',
					eb
						.selectFrom('issue_label')
						.innerJoin('issue', 'issue.id', 'issue_label.issue_id')
						.where('issue.project_id', '=', projectId)
						.select('issue_label.label_id')
				),
				...(matched.length ? [eb('id', 'in', matched)] : [])
			])
		)
		.orderBy('name')
		.limit(LABEL_VOCABULARY_MAX)
		.execute();
	return labels.map((l) => l.name);
}

/** Pure assembly over one snapshot: precedence, caps and conflicts, fail closed. */
async function assemble(
	db: Kysely<Database>,
	snap: Snapshot,
	opts: LoadBundleOptions
): Promise<SharedExecutionBundleV1> {
	if (snap.rows.length > BUNDLE_ITEM_CAP)
		throw bundleFailure('item_cap', { items: snap.rows.length, cap: BUNDLE_ITEM_CAP });
	const matched = assembleEffectiveContext(
		snap.rows,
		snap.files,
		snap.match,
		await journalTarget(db, snap.rows, snap.match)
	);
	const guidance: EffectiveContext = { ...matched, env: [] };
	if (guidance.conflicts.length > 0)
		throw bundleFailure('repo_dir_conflict', { dirs: guidance.conflicts.map((c) => c.dir) });

	const ownerId = snap.target.owner_id;
	const projectId = snap.target.project_id;
	const [artifacts, vocabulary, journal] = await Promise.all([
		listArtifacts(db, ownerId, opts.issueId),
		labelVocabulary(db, ownerId, projectId, snap.rows),
		bundleJournal(db, snap)
	]);
	const detail = await sharedIssueDetail(
		db,
		ownerId,
		projectId,
		opts.issueId,
		guidance,
		artifacts.length
	);
	const bundle: SharedExecutionBundleV1 = {
		version: 1,
		project: {
			id: projectId,
			name: snap.target.project_name,
			owner: { id: ownerId, name: snap.target.owner_name }
		},
		issue: { detail, artifacts, label_vocabulary: vocabulary },
		target: {
			project_id: projectId,
			workflow_id: snap.target.workflow_id,
			state_id: snap.target.state_id,
			state_chain: snap.match.stateChain,
			label_ids: snap.labels.map((l) => l.id),
			launch_state_id: snap.witness.launchStateId
		},
		guidance,
		requirements: [],
		journal,
		digest: snap.witness.digest
	};
	// Display reads carry no file contents, so size is counted the same way for
	// both: the bundle without contents plus the winners' file bytes.
	const shell = {
		...bundle,
		guidance: { ...guidance, skills: guidance.skills.map((s) => ({ ...s, files: [] })) }
	};
	const size = new TextEncoder().encode(JSON.stringify(shell)).length + snap.fileBytes;
	if (size > BUNDLE_SIZE_CAP)
		throw bundleFailure('size_cap', { bytes: size, cap: BUNDLE_SIZE_CAP });
	return bundle;
}

/**
 * The journal this bundle's runs write: the `journal` prompt at project ∧ the
 * root of the launch state's chain for a run, of the issue's chain otherwise —
 * `journalForIssue`'s rule, resolved against the snapshot.
 */
async function bundleJournal(
	db: Kysely<Database>,
	snap: Snapshot
): Promise<SharedExecutionBundleV1['journal']> {
	const chain = snap.witness.launchChain ?? snap.match.stateChain;
	const rootStateId = chain[0];
	const leafStateId = chain[chain.length - 1];
	const row = snap.rows.find(
		(r) =>
			r.kind === 'prompt' &&
			r.name === 'journal' &&
			r.project_id === snap.match.projectId &&
			r.workflow_state_id === rootStateId &&
			r.issue_id === null
	);
	const scope = toContextScope(
		await resolveScope(db, snap.target.owner_id, {
			projectId: snap.match.projectId,
			workflowStateId: rootStateId,
			labelId: null,
			issueId: null
		}),
		{ qualifyState: rootStateId !== leafStateId }
	);
	return {
		scope_label: scope.label,
		anchor: snap.witness.launchChain ? 'run' : 'current',
		item_id: row?.id ?? null,
		version: row?.version ?? null
	};
}

/**
 * The shared bundle for an issue in a shared project, with its witness.
 * Throws 404 when the issue is gone or its project is not shared, 422
 * `bundle_too_large` / 409 `bundle_unavailable` when it cannot be delivered
 * whole. Read-only callers get a validated snapshot (at most
 * `BUNDLE_ATTEMPTS` builds); `validate: false` returns the first coherent
 * build for a caller that guards its own write on the witness.
 */
export async function loadSharedExecutionBundle(
	env: Env,
	db: Kysely<Database>,
	opts: LoadBundleOptions
): Promise<{ bundle: SharedExecutionBundleV1; witness: BundleWitness }> {
	for (let attempt = 1; attempt <= BUNDLE_ATTEMPTS; attempt++) {
		const snap = await snapshot(env, db, opts);
		if (snap === 'moved') continue;
		const bundle = await assemble(db, snap, opts);
		if (opts.validate === false) return { bundle, witness: snap.witness };
		await opts.beforeValidate?.(attempt);
		const live = await db
			.selectNoFrom(bundleWitnessExpr(db, snap.witness).as('vector'))
			.executeTakeFirst();
		if (live?.vector === snap.witness.vector) return { bundle, witness: snap.witness };
	}
	throw bundleFailure('churn');
}

/** The project facts that decide whether an issue reads the shared bundle. */
export async function issueSharedProject(
	db: Kysely<Database>,
	issueId: string
): Promise<{ projectId: string; ownerId: string; shared: boolean } | null> {
	const row = await db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue.project_id', 'project.user_id', 'project.shared_at'])
		.where('issue.id', '=', issueId)
		.executeTakeFirst();
	return row
		? { projectId: row.project_id, ownerId: row.user_id, shared: row.shared_at !== null }
		: null;
}
