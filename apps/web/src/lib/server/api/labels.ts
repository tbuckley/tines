import {
	defaultLabelColor,
	LABEL_COLORS,
	LABEL_NAME_MAX,
	type AddIssueLabelsResponse,
	type CreateLabelRequest,
	type DeleteLabelResponse,
	type IssueLabel,
	type Label,
	type LabelColor,
	type LabelWithUsage,
	type UpdateLabelRequest
} from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import {
	ApiFail,
	notFound,
	optionalString,
	requireString,
	runAtomic,
	type ActorContext
} from './core';
import { eventInsert } from './events';

/**
 * Exactly what `newId('lbl')` mints (16 chars of `ID_ALPHABET`). A ref of
 * this shape that resolves to nothing is a stale id, not a name: get-or-
 * create must refuse it rather than mint a label called `lbl_…`.
 */
const LABEL_ID_RE = /^lbl_[0-9A-Za-z]{16}$/;

const isControlChar = (c: string): boolean => {
	const code = c.codePointAt(0) ?? 0;
	return code < 0x20 || code === 0x7f;
};

/**
 * Trimmed, validated label name. The leading-`-` ban keeps `--label -foo`
 * available for a future negation syntax; control characters would break
 * every table and chip that renders the name.
 */
export function normalizeLabelName(raw: unknown, field = 'name'): string {
	const name = requireString(raw, field).trim();
	if (name.length === 0) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must not be empty`, { field });
	}
	if (name.length > LABEL_NAME_MAX) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be at most ${LABEL_NAME_MAX} characters`, {
			field
		});
	}
	if ([...name].some(isControlChar)) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must not contain control characters`, {
			field
		});
	}
	if (name.startsWith('-')) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must not start with "-"`, { field });
	}
	return name;
}

function normalizeColor(raw: unknown, fallback: LabelColor): LabelColor {
	if (raw === undefined || raw === null) return fallback;
	const color = requireString(raw, 'color', { max: 20 }).trim();
	if (!(LABEL_COLORS as readonly string[]).includes(color)) {
		throw new ApiFail(422, 'invalid_field', `"color" must be one of ${LABEL_COLORS.join(', ')}`, {
			field: 'color',
			known_colors: LABEL_COLORS
		});
	}
	return color as LabelColor;
}

function serializeLabel(row: {
	id: string;
	name: string;
	color: string;
	description: string;
	created_at: number;
	updated_at: number;
}): Label {
	return {
		id: row.id,
		name: row.name,
		color: row.color as LabelColor,
		description: row.description,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

const chip = (l: { id: string; name: string; color: string }): IssueLabel => ({
	id: l.id,
	name: l.name,
	color: l.color as LabelColor
});

/** Resolves a label reference (id first, then name, case-insensitively). */
export async function resolveLabelRef(
	db: Kysely<Database>,
	userId: string,
	ref: string
): Promise<Label | null> {
	const row = await db
		.selectFrom('label')
		.selectAll()
		.where('user_id', '=', userId)
		.where((eb) => eb.or([eb('id', '=', ref), eb(sql`name COLLATE NOCASE`, '=', ref)]))
		// An id match wins over a name that happens to look like an id.
		.orderBy(sql`CASE WHEN id = ${ref} THEN 0 ELSE 1 END`)
		.executeTakeFirst();
	return row ? serializeLabel(row) : null;
}

/** The whole library, with usage counts. Small enough to need no paging. */
export async function listLabels(db: Kysely<Database>, userId: string): Promise<LabelWithUsage[]> {
	const rows = await db
		.selectFrom('label')
		.selectAll('label')
		.select(
			sql<number>`(SELECT COUNT(*) FROM issue_label il WHERE il.label_id = label.id)`.as(
				'issue_count'
			)
		)
		.where('user_id', '=', userId)
		.orderBy(sql`name COLLATE NOCASE`)
		.execute();
	return rows.map((r) => ({ ...serializeLabel(r), issue_count: Number(r.issue_count) }));
}

async function resolveByName(
	db: Kysely<Database>,
	userId: string,
	name: string
): Promise<Label | null> {
	const row = await db
		.selectFrom('label')
		.selectAll()
		.where('user_id', '=', userId)
		.where(sql`name COLLATE NOCASE`, '=', name)
		.executeTakeFirst();
	return row ? serializeLabel(row) : null;
}

async function assertNameFree(
	db: Kysely<Database>,
	userId: string,
	name: string,
	exceptId?: string
): Promise<void> {
	const existing = await resolveByName(db, userId, name);
	if (existing && existing.id !== exceptId) {
		throw new ApiFail(409, 'conflict', `A label named "${existing.name}" already exists`, {
			field: 'name',
			existing: { id: existing.id, name: existing.name }
		});
	}
}

export async function createLabel(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	body: CreateLabelRequest
): Promise<Label> {
	const name = normalizeLabelName(body.name);
	const color = normalizeColor(body.color, defaultLabelColor(name));
	const description = optionalString(body.description, 'description') ?? '';
	await assertNameFree(db, actor.userId, name);

	const now = Date.now();
	const label: Label = {
		id: newId('lbl'),
		name,
		color,
		description,
		created_at: now,
		updated_at: now
	};
	await runAtomic(env, [
		db
			.insertInto('label')
			.values({ ...label, user_id: actor.userId })
			.compile(),
		eventInsert(db, actor, {
			type: 'label.created',
			payload: { label_id: label.id, name, color }
		})
	]);
	return label;
}

export async function updateLabel(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	labelRef: string,
	body: UpdateLabelRequest
): Promise<Label> {
	const label = await resolveLabelRef(db, actor.userId, labelRef);
	if (!label) throw notFound();

	const name = body.name === undefined ? label.name : normalizeLabelName(body.name);
	const color = normalizeColor(body.color, label.color);
	const description =
		body.description === undefined
			? label.description
			: (optionalString(body.description, 'description') ?? '');
	// A pure case change ("bug" to "Bug") renames onto itself, not a conflict.
	if (name.toLowerCase() !== label.name.toLowerCase()) {
		await assertNameFree(db, actor.userId, name, label.id);
	}

	const now = Date.now();
	await runAtomic(env, [
		db
			.updateTable('label')
			.set({ name, color, description, updated_at: now })
			.where('id', '=', label.id)
			.where('user_id', '=', actor.userId)
			.compile(),
		eventInsert(db, actor, {
			type: 'label.updated',
			payload: { label_id: label.id, name, color, previous_name: label.name }
		})
	]);
	return { ...label, name, color, description, updated_at: now };
}

/**
 * Deletes a label and detaches it everywhere. A label is a tag, not a
 * container: being in use is reported, not refused.
 */
export async function deleteLabel(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	labelRef: string
): Promise<DeleteLabelResponse> {
	const label = await resolveLabelRef(db, actor.userId, labelRef);
	if (!label) throw notFound();
	const used = await db
		.selectFrom('issue_label')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('label_id', '=', label.id)
		.executeTakeFirst();
	const issueCount = Number(used?.n ?? 0);

	await runAtomic(env, [
		// Explicit, because D1 does not enforce foreign keys by default.
		db.deleteFrom('issue_label').where('label_id', '=', label.id).compile(),
		db.deleteFrom('label').where('id', '=', label.id).where('user_id', '=', actor.userId).compile(),
		eventInsert(db, actor, {
			type: 'label.deleted',
			payload: { label_id: label.id, name: label.name, issue_count: issueCount }
		})
	]);
	return { deleted: true, issue_count: issueCount };
}

export interface ResolvedLabels {
	/** Labels to attach, in request order, deduped. */
	labels: Label[];
	/** Those that did not exist and still need inserting. */
	toCreate: Label[];
}

/**
 * Resolves label refs for an apply, creating unknown ones for human and
 * named-key actors. Run keys may only apply labels that already exist:
 * agents classify their own work, they do not invent the taxonomy. Nothing
 * is applied when any name is unknown - the 422 lists them all plus the
 * known vocabulary, the same shape as `unknown_state`.
 */
export async function resolveOrCreateLabels(
	db: Kysely<Database>,
	actor: ActorContext,
	refs: unknown,
	field = 'labels'
): Promise<ResolvedLabels> {
	if (!Array.isArray(refs)) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must be an array of label names`, {
			field
		});
	}
	const names = refs.map((r) => normalizeLabelName(r, field));

	const labels: Label[] = [];
	const toCreate: Label[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	const now = Date.now();
	for (const name of names) {
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const existing = await resolveLabelRef(db, actor.userId, name);
		if (existing) {
			labels.push(existing);
			continue;
		}
		if (actor.agentRunId || LABEL_ID_RE.test(name)) {
			unknown.push(name);
			continue;
		}
		const created: Label = {
			id: newId('lbl'),
			name,
			color: defaultLabelColor(name),
			description: '',
			created_at: now,
			updated_at: now
		};
		labels.push(created);
		toCreate.push(created);
	}

	if (unknown.length > 0) {
		const known = await listLabels(db, actor.userId);
		// For a human every other miss was created, so `unknown` here can only
		// hold stale ids - a page that loaded before someone deleted the label.
		const why = actor.agentRunId
			? `Run keys can apply existing labels only - ask a human to add it, or use one of: ` +
				`${known.map((l) => l.name).join(', ') || '(none yet)'}`
			: 'It may have been deleted since the page loaded - reload and pick again.';
		throw new ApiFail(422, 'unknown_label', `No such label: ${unknown.join(', ')}. ${why}`, {
			field,
			unknown,
			known_labels: known.map((l) => ({ id: l.id, name: l.name }))
		});
	}
	return { labels, toCreate };
}

/**
 * Compiled inserts for labels created on the fly, for the caller's batch.
 *
 * `OR IGNORE` makes get-or-create race-safe: two concurrent applies of the
 * same new name both miss the resolve and both mint an id, and the loser's
 * insert would otherwise fail `label_user_name_uq` and surface as a 500.
 * Ignoring it leaves the winner's row in place — and `issueLabelInserts`
 * attaches by name, so the loser still ends up pointing at that row.
 */
export function labelInserts(
	db: Kysely<Database>,
	actor: ActorContext,
	toCreate: Label[]
): CompiledQuery[] {
	return toCreate.flatMap((l) => [
		sql`INSERT OR IGNORE INTO label (id, user_id, name, color, description, created_at, updated_at)
			VALUES (${l.id}, ${actor.userId}, ${l.name}, ${l.color}, ${l.description},
				${l.created_at}, ${l.updated_at})`.compile(db),
		eventInsert(db, actor, {
			type: 'label.created',
			payload: { label_id: l.id, name: l.name, color: l.color }
		})
	]);
}

/** Compiled attach + event for each label on one issue. */
export function issueLabelInserts(
	db: Kysely<Database>,
	actor: ActorContext,
	issue: { id: string; project_id: string },
	labels: Label[],
	now: number
): CompiledQuery[] {
	return labels.flatMap((l) => [
		// By name, not by the id in hand: if this label was created on the fly
		// and a concurrent request won the insert, the winner's id is the one
		// that exists. For an already-resolved label the name is its own id.
		sql`INSERT OR IGNORE INTO issue_label (issue_id, label_id, created_at)
			SELECT ${issue.id}, id, ${now} FROM label
			WHERE user_id = ${actor.userId} AND name = ${l.name} COLLATE NOCASE`.compile(db),
		eventInsert(db, actor, {
			type: 'issue.labeled',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { label_id: l.id, name: l.name, color: l.color }
		})
	]);
}

async function loadIssueLabels(db: Kysely<Database>, issueId: string): Promise<IssueLabel[]> {
	const rows = await db
		.selectFrom('issue_label')
		.innerJoin('label', 'label.id', 'issue_label.label_id')
		.select(['label.id', 'label.name', 'label.color'])
		.where('issue_label.issue_id', '=', issueId)
		.orderBy(sql`label.name COLLATE NOCASE`)
		.execute();
	return rows.map(chip);
}

/**
 * Resolves an issue by id or `Project/N`, scoped to the actor. Deliberately
 * a plain query rather than `issueQuery`: `issues.ts` imports this module
 * for the create path, so importing back would close a cycle.
 */
async function requireIssue(db: Kysely<Database>, userId: string, ref: string) {
	const match = /^([^/]+)\/#?(\d+)$/.exec(ref);
	let q = db
		.selectFrom('issue')
		.innerJoin('project', 'project.id', 'issue.project_id')
		.select(['issue.id', 'issue.project_id', 'project.name as project_name', 'issue.number'])
		.where('project.user_id', '=', userId);
	q = match
		? q.where('project.name', '=', match[1]).where('issue.number', '=', Number(match[2]))
		: q.where('issue.id', '=', ref);
	const issue = await q.executeTakeFirst();
	if (!issue) throw notFound();
	return issue;
}

/**
 * Adds labels to an issue. Idempotent: re-adding an attached label is a 200
 * with an empty `added`, so a retrying agent never sees an error.
 */
export async function addIssueLabels(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueRef: string,
	refs: unknown
): Promise<AddIssueLabelsResponse> {
	const issue = await requireIssue(db, actor.userId, issueRef);
	const { labels, toCreate } = await resolveOrCreateLabels(db, actor, refs);

	const already = new Set((await loadIssueLabels(db, issue.id)).map((l) => l.id));
	const added = labels.filter((l) => !already.has(l.id));
	if (added.length > 0) {
		const now = Date.now();
		await runAtomic(env, [
			...labelInserts(db, actor, toCreate),
			...issueLabelInserts(db, actor, issue, added, now)
		]);
	}
	const final = await loadIssueLabels(db, issue.id);
	// Report the chips that actually landed: a label created on the fly may
	// have lost the insert race to a concurrent request with the same name,
	// in which case the id in hand was ignored and the winner's is live.
	const byName = new Map(final.map((l) => [l.name.toLowerCase(), l]));
	const landed = (l: Label) => byName.get(l.name.toLowerCase()) ?? chip(l);
	return {
		labels: final,
		added: added.map(landed),
		created: toCreate.filter((c) => added.some((a) => a.id === c.id)).map(landed)
	};
}

export async function removeIssueLabel(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	issueRef: string,
	labelRef: string
): Promise<void> {
	const issue = await requireIssue(db, actor.userId, issueRef);
	const label = await resolveLabelRef(db, actor.userId, labelRef);
	const attached = label
		? await db
				.selectFrom('issue_label')
				.select('label_id')
				.where('issue_id', '=', issue.id)
				.where('label_id', '=', label.id)
				.executeTakeFirst()
		: undefined;
	if (!label || !attached) {
		throw new ApiFail(
			404,
			'label_not_on_issue',
			`${issue.project_name}/${issue.number} does not have the label "${labelRef}"`
		);
	}

	await runAtomic(env, [
		db
			.deleteFrom('issue_label')
			.where('issue_id', '=', issue.id)
			.where('label_id', '=', label.id)
			.compile(),
		eventInsert(db, actor, {
			type: 'issue.unlabeled',
			issueId: issue.id,
			projectId: issue.project_id,
			payload: { label_id: label.id, name: label.name, color: label.color }
		})
	]);
}
