import {
	defaultLabelColor,
	LABEL_COLORS,
	LABEL_NAME_MAX,
	type AddIssueLabelsResponse,
	type ContextKind,
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
	runKeyForbidden,
	type ActorContext
} from './core';
import { assertWritable, issueProject } from './archive';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import { contextItemQuery, deleteContextItem } from './context';
import { routingRuleDeletes, rulesScopedToLabel } from './routing';
import { eventInsert } from './events';
import { insertValues, type QueryGuard } from './query-guard';
import { scopeLabel } from './scope';

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
		throw new ApiFail(
			422,
			'invalid_field',
			`"${field}" must be at most ${LABEL_NAME_MAX} characters`,
			{
				field
			}
		);
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
		.select([
			sql<number>`(SELECT COUNT(*) FROM issue_label il WHERE il.label_id = label.id)`.as(
				'issue_count'
			),
			sql<number>`(SELECT COUNT(*) FROM context_item ci WHERE ci.label_id = label.id)`.as(
				'context_item_count'
			),
			sql<number>`(SELECT COUNT(*) FROM routing_rule rr WHERE rr.label_id = label.id)`.as(
				'routing_rule_count'
			)
		])
		.where('user_id', '=', userId)
		.orderBy(sql`name COLLATE NOCASE`)
		.execute();
	return rows.map((r) => ({
		...serializeLabel(r),
		issue_count: Number(r.issue_count),
		context_item_count: Number(r.context_item_count),
		routing_rule_count: Number(r.routing_rule_count)
	}));
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

/** Strict creation: unlike on-the-fly labelInserts, a collision must fail the batch. */
export function labelInsertQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	label: Label,
	options: { guard?: QueryGuard; eventId?: string } = {}
): CompiledQuery[] {
	return [
		insertValues(db, 'label', { ...label, user_id: actor.userId }, options.guard),
		eventInsert(
			db,
			actor,
			{
				id: options.eventId,
				createdAt: label.created_at,
				type: 'label.created',
				payload: { label_id: label.id, name: label.name, color: label.color }
			},
			options.guard
		)
	];
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
	await runAtomic(env, labelInsertQueries(db, actor, label));
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
 * Deletes a label and detaches it everywhere.
 *
 * Being *carried* by issues is reported, not refused — a label is a tag. But
 * a label a context item or a routing rule is **scoped to** is more than a
 * tag: dropping it would silently change what an agent is handed or where it
 * runs. Those are refused (422 `label_in_use`) unless `force`, which deletes
 * the scoped items and rules along with the label. A rule is deleted rather
 * than label-stripped on purpose: stripping would broaden
 * `label docs ∧ project X` into `project X`, quietly routing more work.
 */
export async function deleteLabel(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	labelRef: string,
	options: { force?: boolean } = {}
): Promise<DeleteLabelResponse> {
	const label = await resolveLabelRef(db, actor.userId, labelRef);
	if (!label) throw notFound();
	const scopedItems = (
		await contextItemQuery(db, actor.userId).where('context_item.label_id', '=', label.id).execute()
	).map((row) => ({
		id: row.id,
		kind: row.kind as ContextKind,
		name: row.name,
		scope_label: scopeLabel({
			projectId: row.project_id,
			projectName: row.scope_project_name,
			workflowStateId: row.workflow_state_id,
			stateName: row.scope_state_name,
			labelId: row.label_id,
			labelName: row.scope_label_name,
			issueId: row.issue_id,
			issueProjectName: row.scope_issue_project_name,
			issueNumber: row.scope_issue_number
		})
	}));
	const scopedRules = await rulesScopedToLabel(db, actor.userId, label.id);
	if ((scopedItems.length > 0 || scopedRules.length > 0) && !options.force) {
		const parts: string[] = [];
		if (scopedItems.length > 0) {
			const shown = scopedItems
				.slice(0, 5)
				.map((i) => `${i.kind} "${i.name}" (${i.scope_label})`)
				.join(', ');
			parts.push(
				`${scopedItems.length} context item${scopedItems.length === 1 ? '' : 's'} (${shown}${scopedItems.length > 5 ? ', …' : ''})`
			);
		}
		if (scopedRules.length > 0) {
			const shown = scopedRules
				.slice(0, 5)
				.map((r) => r.scope_label)
				.join(', ');
			parts.push(
				`${scopedRules.length} routing rule${scopedRules.length === 1 ? '' : 's'} (${shown}${scopedRules.length > 5 ? ', …' : ''})`
			);
		}
		throw new ApiFail(
			422,
			'label_in_use',
			`Cannot delete label "${label.name}": it scopes ${parts.join(' and ')}. Pass "force": true to delete them with the label — rules are deleted, not broadened`,
			{ context_items: scopedItems, routing_rules: scopedRules }
		);
	}
	for (const item of scopedItems) {
		await deleteContextItem(db, env, actor, item.id);
	}
	const used = await db
		.selectFrom('issue_label')
		.select((eb) => eb.fn.countAll<number>().as('n'))
		.where('label_id', '=', label.id)
		.executeTakeFirst();
	const issueCount = Number(used?.n ?? 0);

	await runAtomic(env, [
		// A label-scoped rule goes with the label: see `routingRuleDeletes`.
		...routingRuleDeletes(db, actor, scopedRules),
		// Explicit, because D1 does not enforce foreign keys by default.
		db.deleteFrom('issue_label').where('label_id', '=', label.id).compile(),
		db.deleteFrom('label').where('id', '=', label.id).where('user_id', '=', actor.userId).compile(),
		eventInsert(db, actor, {
			type: 'label.deleted',
			payload: {
				label_id: label.id,
				name: label.name,
				issue_count: issueCount,
				context_item_count: scopedItems.length,
				routing_rule_count: scopedRules.length,
				forced: options.force === true
			}
		})
	]);
	if (scopedRules.length > 0) effects.signalDispatch();
	return {
		deleted: true,
		issue_count: issueCount,
		context_items_deleted: scopedItems,
		routing_rules_deleted: scopedRules.map((r) => ({ id: r.id, scope_label: r.scope_label }))
	};
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
	toCreate: Label[],
	guard?: QueryGuard
): CompiledQuery[] {
	return toCreate.flatMap((l) => [
		sql`INSERT OR IGNORE INTO label (id, user_id, name, color, description, created_at, updated_at)
			SELECT ${l.id}, ${actor.userId}, ${l.name}, ${l.color}, ${l.description},
				${l.created_at}, ${l.updated_at}
			${guard ? sql`WHERE ${guard.predicate}` : sql``}`.compile(db),
		eventInsert(
			db,
			actor,
			{
				type: 'label.created',
				payload: { label_id: l.id, name: l.name, color: l.color }
			},
			guard
		)
	]);
}

/** Compiled attach + event for each label on one issue. */
export function issueLabelInserts(
	db: Kysely<Database>,
	actor: ActorContext,
	issue: { id: string; project_id: string },
	labels: Label[],
	now: number,
	guard?: QueryGuard
): CompiledQuery[] {
	return labels.flatMap((l) => [
		// By name, not by the id in hand: if this label was created on the fly
		// and a concurrent request won the insert, the winner's id is the one
		// that exists. For an already-resolved label the name is its own id.
		sql`INSERT OR IGNORE INTO issue_label (issue_id, label_id, created_at)
			SELECT ${issue.id}, id, ${now} FROM label
			WHERE user_id = ${actor.userId} AND name = ${l.name} COLLATE NOCASE
				${guard ? sql`AND ${guard.predicate}` : sql``}`.compile(db),
		eventInsert(
			db,
			actor,
			{
				type: 'issue.labeled',
				issueId: issue.id,
				projectId: issue.project_id,
				payload: { label_id: l.id, name: l.name, color: l.color }
			},
			guard
		)
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
		.select([
			'issue.id',
			'issue.project_id',
			'project.name as project_name',
			'project.archived_at as project_archived_at',
			'issue.number'
		])
		.where('project.user_id', '=', userId);
	q = match
		? q.where('project.name', '=', match[1]).where('issue.number', '=', Number(match[2]))
		: q.where('issue.id', '=', ref);
	const issue = await q.executeTakeFirst();
	if (!issue) throw notFound();
	return issue;
}

/**
 * A run key may classify its own issue, but not with a label a routing rule
 * is scoped to. Routing is resolved at dispatch, so such a change cannot
 * re-route the *current* run — but it can route the issue's next attempt
 * (say, to the smartest tier), which is the self-escalation the control-plane
 * fence exists to prevent. Label-scoped *context* is guidance, not control,
 * and stays freely self-applicable.
 *
 * One indexed lookup on `routing_rule_label_idx`, run-key actors only, and it
 * runs before anything is written: the call is all-or-nothing, like an
 * `unknown_label` miss.
 */
async function assertLabelsDoNotRoute(
	db: Kysely<Database>,
	actor: ActorContext,
	labels: Label[]
): Promise<void> {
	if (!actor.agentRunId || labels.length === 0) return;
	const rules = await db
		.selectFrom('routing_rule')
		.select(['id', 'label_id'])
		.where('user_id', '=', actor.userId)
		.where(
			'label_id',
			'in',
			labels.map((l) => l.id)
		)
		.execute();
	if (rules.length === 0) return;
	const routed = labels.filter((l) => rules.some((r) => r.label_id === l.id));
	throw runKeyForbidden({
		reason: 'routing_label',
		labels: routed.map((l) => l.name),
		rule_ids: rules.map((r) => r.id)
	});
}

/**
 * Adds labels to an issue. Idempotent: re-adding an attached label is a 200
 * with an empty `added`, so a retrying agent never sees an error.
 */
export async function addIssueLabels(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	effects: DispatchEffects,
	issueRef: string,
	refs: unknown
): Promise<AddIssueLabelsResponse> {
	const issue = await requireIssue(db, actor.userId, issueRef);
	await assertWritable(db, actor, issueProject(issue), { issueId: issue.id });
	const { labels, toCreate } = await resolveOrCreateLabels(db, actor, refs);
	await assertLabelsDoNotRoute(db, actor, labels);

	const already = new Set((await loadIssueLabels(db, issue.id)).map((l) => l.id));
	const added = labels.filter((l) => !already.has(l.id));
	if (added.length > 0) {
		const now = Date.now();
		await runAtomic(env, [
			...labelInserts(db, actor, toCreate),
			...issueLabelInserts(db, actor, issue, added, now)
		]);
		effects.signalDispatch();
	}
	const final = await loadIssueLabels(db, issue.id);
	// Report the chips that actually landed: a label created on the fly may
	// have lost the insert race to a concurrent request with the same name,
	// in which case the id in hand was ignored and the winner's is live.
	const byName = new Map(final.map((l) => [l.name.toLowerCase(), l]));
	const landed = (l: Label) => byName.get(l.name.toLowerCase()) ?? chip(l);
	if (added.length === 0) effects.signalDispatch();
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
	effects: DispatchEffects,
	issueRef: string,
	labelRef: string
): Promise<void> {
	const issue = await requireIssue(db, actor.userId, issueRef);
	await assertWritable(db, actor, issueProject(issue), { issueId: issue.id });
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

	await assertLabelsDoNotRoute(db, actor, [label]);

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
	effects.signalDispatch();
}
