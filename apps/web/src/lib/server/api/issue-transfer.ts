import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { getDb, newId, type Database } from '$lib/server/db';
import { nextIssueNumber } from '$lib/server/issue-address';
import {
	TRANSFER_PREVIEW_TTL_MS,
	hashTransferWitness,
	mintTransferWitness,
	transferKeyMaterial,
	transferWitnessExpressions,
	verifyTransferWitness,
	type TransferWitnessPayload,
	type TransferWitnessSections
} from '$lib/server/issue-transfer-witness';
import { ApiFail, notFound, runAtomic, type ActorContext } from './core';
import { loadIssue } from './issues';
import { effectiveContextForTarget, issueMatchTarget } from './context';
import { explainDispatch } from '$lib/server/supervisor/explain';
import type { DispatchEffects } from '$lib/server/dispatch-effects';
import type {
	ContextScope,
	DispatchExplainer,
	EffectiveContext,
	Issue,
	IssueTransferBlocker,
	IssueTransferContextChange,
	IssueTransferPreserved,
	IssueTransferPreview,
	IssueTransferProject,
	IssueTransferRef,
	IssueTransferResult,
	IssueTransferSchedule
} from '@tines/shared';

interface WitnessIssue {
	id: string;
	project_id: string;
	number: number;
	project_assignment_token: string;
}

interface WitnessProject {
	id: string;
	name: string;
	user_id: string;
	archived_at: number | null;
}

interface WitnessIssueSection {
	issue: WitnessIssue;
	source: WitnessProject;
	destination: WitnessProject;
}

interface TransferQueryBatch {
	queries: CompiledQuery[];
	eventId: string;
	newAssignmentToken: string;
}

async function readWitnessSections(
	db: Kysely<Database>,
	issueId: string,
	destinationId: string
): Promise<TransferWitnessSections | null> {
	const witness = transferWitnessExpressions(issueId, destinationId);
	const result = await sql<{
		issue_witness: string | null;
		context_witness: string;
		routing_witness: string;
	}>`
		SELECT ${witness.issue} AS issue_witness, ${witness.context} AS context_witness,
			${witness.routing} AS routing_witness
	`.execute(db);
	const row = result.rows[0];
	if (!row?.issue_witness) return null;
	return {
		issue: row.issue_witness,
		context: row.context_witness,
		routing: row.routing_witness
	};
}

function parseIssueSection(sections: TransferWitnessSections): WitnessIssueSection {
	return JSON.parse(sections.issue) as WitnessIssueSection;
}

async function activeRun(
	db: Kysely<Database>,
	issueId: string
): Promise<{ id: string; status: string } | undefined> {
	return db
		.selectFrom('agent_run')
		.select(['id', 'status'])
		.where('issue_id', '=', issueId)
		.where('status', 'in', ['assigned', 'launching', 'running'])
		.orderBy('created_at desc')
		.executeTakeFirst();
}

function blockersFor(
	actor: ActorContext,
	section: WitnessIssueSection,
	run: { id: string; status: string } | undefined
): IssueTransferBlocker[] {
	const blockers: IssueTransferBlocker[] = [];
	if (actor.agentRunId) {
		blockers.push({
			code: 'run_key_forbidden',
			message: 'A run key cannot transfer an issue',
			remedy: 'Ask an operator to review and move it'
		});
	}
	for (const [role, project] of [
		['source', section.source],
		['destination', section.destination]
	] as const) {
		if (project.archived_at !== null) {
			blockers.push({
				code: 'project_archived',
				message: `The ${role} project ${project.name} is archived`,
				remedy: `tines projects unarchive ${project.name}`
			});
		}
	}
	if (run) {
		blockers.push({
			code: 'issue_busy',
			message: `Run ${run.id} is ${run.status}; wait for it to finish or cancel it separately`,
			run_id: run.id,
			run_status: run.status,
			remedy: `tines runs show ${run.id}`
		});
	}
	return blockers;
}

function transferProject(project: WitnessProject): IssueTransferProject {
	return { id: project.id, name: project.name, archived: project.archived_at !== null };
}

function transferRef(project: WitnessProject, number: number): IssueTransferRef {
	return {
		project_id: project.id,
		project_name: project.name,
		number,
		ref: `${project.name}/${number}`
	};
}

/** Scope equality across the move: only the project dimension may differ. */
function sameScope(a: ContextScope, b: ContextScope): boolean {
	return (
		a.project_id === b.project_id &&
		a.workflow_state_id === b.workflow_state_id &&
		a.label_id === b.label_id &&
		a.issue_id === b.issue_id
	);
}

interface SideItem {
	item_id: string;
	name: string;
	kind: IssueTransferContextChange['kind'];
	scope: ContextScope;
	effective: boolean;
	repo: { url: string; branch?: string | null; dir: string } | null;
}

function sideItems(context: EffectiveContext): Map<string, SideItem> {
	const items = new Map<string, SideItem>();
	for (const part of context.prompt.parts) {
		items.set(part.item_id, {
			item_id: part.item_id,
			name: part.name,
			kind: 'prompt',
			scope: part.scope,
			effective: true,
			repo: null
		});
	}
	for (const skill of context.skills) {
		items.set(skill.item_id, {
			item_id: skill.item_id,
			name: skill.name,
			kind: 'skill',
			scope: skill.scope,
			effective: true,
			repo: null
		});
	}
	for (const repo of context.repos) {
		items.set(repo.item_id, {
			item_id: repo.item_id,
			name: repo.name,
			kind: 'repo',
			scope: repo.scope,
			effective: true,
			repo: { url: repo.url, branch: repo.branch, dir: repo.dir }
		});
	}
	// Overridden candidates are part of the review: an operator needs to see the
	// item that loses its name at the destination, not only the winner.
	for (const lost of context.overridden) {
		if (items.has(lost.item_id)) continue;
		items.set(lost.item_id, {
			item_id: lost.item_id,
			name: lost.name,
			kind: lost.kind as IssueTransferContextChange['kind'],
			scope: lost.scope,
			effective: false,
			repo: null
		});
	}
	return items;
}

/**
 * Item-level classification of the two assemblies. `replaced` is the case an
 * operator most needs to see: the item still matches, but a same-name item at
 * the destination now wins its slot (or stops winning it).
 */
export function diffEffectiveContext(
	before: EffectiveContext,
	after: EffectiveContext
): IssueTransferContextChange[] {
	const beforeItems = sideItems(before);
	const afterItems = sideItems(after);
	const changes: IssueTransferContextChange[] = [];
	for (const id of new Set([...beforeItems.keys(), ...afterItems.keys()])) {
		const b = beforeItems.get(id);
		const a = afterItems.get(id);
		const item = a ?? b;
		if (!item) continue;
		let change: IssueTransferContextChange['change'];
		if (!b) change = 'added';
		else if (!a) change = 'removed';
		else if (!sameScope(b.scope, a.scope)) change = 'rescoped';
		else if (b.effective !== a.effective) change = 'replaced';
		else change = 'retained';
		changes.push({
			item_id: item.item_id,
			name: item.name,
			kind: item.kind,
			change,
			scope_before: b?.scope ?? null,
			scope_after: a?.scope ?? null,
			effective_before: b?.effective ?? false,
			effective_after: a?.effective ?? false,
			...(item.kind === 'repo' ? { repo_before: b?.repo ?? null, repo_after: a?.repo ?? null } : {})
		});
	}
	return changes.sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
}

/**
 * The routing the next launch would resolve, with queue position dropped: an
 * issue's place in a hypothetical destination queue is not a real position, and
 * a preview must not claim one.
 */
function advisoryRouting(explainer: DispatchExplainer | null): DispatchExplainer | null {
	return explainer ? { ...explainer, queue_position: null } : null;
}

async function preservedRecord(
	db: Kysely<Database>,
	issue: Issue
): Promise<IssueTransferPreserved> {
	const [comments, artifacts, runs, links] = await Promise.all([
		db
			.selectFrom('comment')
			.select(({ fn }) => fn.countAll<number>().as('c'))
			.where('issue_id', '=', issue.id)
			.executeTakeFirst(),
		db
			.selectFrom('artifact_version')
			.innerJoin('context_item', 'context_item.id', 'artifact_version.context_item_id')
			.select(({ fn }) => [
				fn.countAll<number>().as('versions'),
				fn.count<number>('context_item.id').distinct().as('slots')
			])
			.where('context_item.kind', '=', 'artifact')
			.where('context_item.issue_id', '=', issue.id)
			.executeTakeFirst(),
		db
			.selectFrom('agent_run')
			.select(({ fn }) => fn.countAll<number>().as('c'))
			.where('issue_id', '=', issue.id)
			.executeTakeFirst(),
		db
			.selectFrom('issue_link')
			.select(({ fn }) => fn.countAll<number>().as('c'))
			.where((eb) =>
				eb.or([eb('source_issue_id', '=', issue.id), eb('target_issue_id', '=', issue.id)])
			)
			.executeTakeFirst()
	]);
	return {
		title: issue.title,
		workflow_id: issue.workflow_id,
		state_id: issue.state.id,
		state_entered_at: issue.state_entered_at,
		created_at: issue.created_at,
		labels: issue.labels.map((l) => ({ id: l.id, name: l.name })),
		pinned_runner_id: issue.pinned_runner_id,
		pinned_tier: issue.pinned_tier,
		attempt_count: issue.attempt_count,
		parked: issue.needs_attention,
		comment_count: Number(comments?.c ?? 0),
		artifact_count: Number(artifacts?.slots ?? 0),
		artifact_version_count: Number(artifacts?.versions ?? 0),
		run_count: Number(runs?.c ?? 0),
		link_count: Number(links?.c ?? 0)
	};
}

function scheduleSummary(issue: Issue): IssueTransferSchedule | null {
	if (!issue.scheduled_task_id || !issue.scheduled_task_project_id) return null;
	return {
		id: issue.scheduled_task_id,
		name: issue.scheduled_task_name ?? issue.scheduled_task_id,
		project_id: issue.scheduled_task_project_id,
		project_name: issue.scheduled_task_project_name ?? '',
		notice:
			"This instance keeps its schedule and still blocks its closure gate. Future instances are created in the schedule's own project."
	};
}

export async function previewIssueTransfer(
	env: Env,
	actor: ActorContext,
	issueId: string,
	destinationId: string,
	now = Date.now(),
	readAttempt = 0
): Promise<IssueTransferPreview> {
	const db = getDb(env);
	const sections = await readWitnessSections(db, issueId, destinationId);
	if (!sections) throw notFound();
	const section = parseIssueSection(sections);
	if (section.source.user_id !== actor.userId || section.destination.user_id !== actor.userId) {
		throw notFound();
	}
	const noop = section.source.id === section.destination.id;
	const run = await activeRun(db, issueId);
	const blockers = blockersFor(actor, section, run);
	const keyMaterial = transferKeyMaterial(env);
	if (!keyMaterial) {
		throw new ApiFail(
			503,
			'transfer_preview_unavailable',
			'Issue transfer previews need SECRET_ENCRYPTION_KEY or BETTER_AUTH_SECRET'
		);
	}

	// The review itself: both assemblies come from the ordinary resolvers, so a
	// preview cannot drift from what the destination launch would actually do.
	const issue = await loadIssue(db, actor.userId, { id: issueId });
	const target = await issueMatchTarget(db, actor.userId, issueId);
	const [contextBefore, contextAfter, routingBefore, routingAfter, preserved] = await Promise.all([
		effectiveContextForTarget(db, actor.userId, target),
		effectiveContextForTarget(
			db,
			actor.userId,
			{ ...target, projectId: section.destination.id },
			{
				projection: {
					fromProjectId: section.source.id,
					toProjectId: section.destination.id,
					toProjectName: section.destination.name,
					toProjectArchivedAt: section.destination.archived_at
				}
			}
		),
		explainDispatch(db, actor.userId, issueId, now, issue),
		explainDispatch(db, actor.userId, issueId, now, {
			...issue,
			project_id: section.destination.id,
			project_name: section.destination.name
		}),
		preservedRecord(db, issue)
	]);
	// D1 does not expose an interactive read transaction. Bracket the ordinary
	// resolvers with the complete dependency witness and only sign a review whose
	// inputs stayed identical for the entire assembly. A busy configuration gets
	// a fresh attempt rather than a mixed review.
	const settledSections = await readWitnessSections(db, issueId, destinationId);
	if (!settledSections || JSON.stringify(settledSections) !== JSON.stringify(sections)) {
		if (readAttempt < 2) {
			return previewIssueTransfer(env, actor, issueId, destinationId, now, readAttempt + 1);
		}
		throw new ApiFail(
			409,
			'transfer_preview_stale',
			'The issue or transfer configuration kept changing; refresh and review again'
		);
	}

	const summary: TransferWitnessPayload['r'] = {
		preserved,
		context_changes: diffEffectiveContext(contextBefore, contextAfter),
		routing: { before: advisoryRouting(routingBefore), after: advisoryRouting(routingAfter) },
		schedule: scheduleSummary(issue)
	};
	const payload: TransferWitnessPayload = {
		v: 1,
		u: actor.userId,
		i: issueId,
		s: section.source.id,
		d: destinationId,
		a: section.issue.project_assignment_token,
		n: section.issue.number,
		e: now + TRANSFER_PREVIEW_TTL_MS,
		h: await hashTransferWitness(sections),
		r: summary
	};
	const canCommit = blockers.length === 0;
	return {
		issue_id: issueId,
		source: transferProject(section.source),
		destination: transferProject(section.destination),
		old_ref: transferRef(section.source, section.issue.number),
		new_ref: null,
		number_notice: 'Number assigned when you move.',
		preserved,
		context: {
			before: contextBefore,
			after: contextAfter,
			changes: summary.context_changes
		},
		routing: summary.routing,
		schedule: summary.schedule,
		noop,
		can_commit: canCommit,
		blockers,
		preview_token: canCommit ? await mintTransferWitness(payload, keyMaterial) : null,
		previewed_at: now
	};
}

export function transferIssueQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	payload: TransferWitnessPayload,
	sections: TransferWitnessSections,
	now: number
): TransferQueryBatch {
	const eventId = newId('evt');
	const newAssignmentToken = newId('asg');
	const witness = transferWitnessExpressions(payload.i, payload.d);
	const moved = sql<boolean>`EXISTS (
		SELECT 1 FROM issue
		WHERE id = ${payload.i} AND project_id = ${payload.d}
			AND project_assignment_token = ${newAssignmentToken}
	)`;
	const issueUpdate = sql`
		UPDATE issue
		SET project_id = ${payload.d},
			number = ${nextIssueNumber(payload.d)},
			project_assignment_token = ${newAssignmentToken},
			updated_at = ${now}
		WHERE id = ${payload.i}
			AND project_id = ${payload.s}
			AND number = ${payload.n}
			AND project_assignment_token = ${payload.a}
			AND EXISTS (SELECT 1 FROM project WHERE id = ${payload.s}
				AND user_id = ${payload.u} AND archived_at IS NULL)
			AND EXISTS (SELECT 1 FROM project WHERE id = ${payload.d}
				AND user_id = ${payload.u} AND archived_at IS NULL)
			AND NOT EXISTS (SELECT 1 FROM agent_run WHERE issue_id = ${payload.i}
				AND status IN ('assigned', 'launching', 'running'))
			AND ${witness.issue} = ${sections.issue}
			AND ${witness.context} = ${sections.context}
			AND ${witness.routing} = ${sections.routing}
	`.compile(db);
	const contextUpdate = sql`
		UPDATE context_item SET project_id = ${payload.d}
		WHERE issue_id = ${payload.i} AND project_id = ${payload.s} AND ${moved}
	`.compile(db);
	const eventInsert = sql`
		INSERT INTO event (
			id, user_id, type, actor_user_id, actor_api_key_id,
			issue_id, project_id, payload, created_at
		)
		SELECT ${eventId}, ${payload.u}, 'issue.transferred', ${actor.userId}, ${actor.apiKeyId},
			issue.id, issue.project_id,
			json_object(
				'source_project_id', ${payload.s},
				'source_project_name', (SELECT name FROM project WHERE id = ${payload.s}),
				'destination_project_id', issue.project_id,
				'destination_project_name', project.name,
				'old_number', ${payload.n}, 'new_number', issue.number,
				'old_ref', (SELECT name FROM project WHERE id = ${payload.s}) || '/' || CAST(${payload.n} AS INTEGER),
				'new_ref', project.name || '/' || issue.number
			), ${now}
		FROM issue JOIN project ON project.id = issue.project_id
		WHERE issue.id = ${payload.i} AND ${moved}
	`.compile(db);
	const receipt = sql`
		SELECT issue.id AS issue_id, issue.number, issue.project_id,
			project.name AS project_name, event.id AS event_id
		FROM issue
		JOIN project ON project.id = issue.project_id
		JOIN event ON event.id = ${eventId}
			AND event.issue_id = issue.id
			AND event.project_id = issue.project_id
			AND event.type = 'issue.transferred'
		WHERE issue.id = ${payload.i} AND issue.project_id = ${payload.d} AND ${moved}
	`.compile(db);
	return {
		queries: [issueUpdate, contextUpdate, eventInsert, receipt],
		eventId,
		newAssignmentToken
	};
}

export async function commitIssueTransfer(
	env: Env,
	actor: ActorContext,
	issueId: string,
	destinationId: string,
	previewToken: string,
	now = Date.now(),
	effects?: DispatchEffects
): Promise<IssueTransferResult> {
	if (actor.agentRunId) {
		throw new ApiFail(
			403,
			'run_key_forbidden',
			'A run key cannot transfer an issue; ask an operator to move it'
		);
	}
	const keyMaterial = transferKeyMaterial(env);
	if (!keyMaterial) {
		throw new ApiFail(
			503,
			'transfer_preview_unavailable',
			'Issue transfer previews need SECRET_ENCRYPTION_KEY or BETTER_AUTH_SECRET'
		);
	}
	const verified = await verifyTransferWitness(previewToken, keyMaterial, now);
	if (!verified.ok) {
		throw new ApiFail(
			verified.reason === 'expired' ? 409 : 422,
			verified.reason === 'expired' ? 'transfer_preview_stale' : 'invalid_preview_token',
			verified.reason === 'expired'
				? 'The transfer preview expired; refresh it and confirm again'
				: 'The transfer preview token is invalid; obtain a new preview'
		);
	}
	const payload = verified.payload;
	if (payload.u !== actor.userId || payload.i !== issueId || payload.d !== destinationId) {
		throw new ApiFail(
			422,
			'invalid_preview_token',
			'The transfer preview does not match this request'
		);
	}
	const db = getDb(env);
	const sections = await readWitnessSections(db, issueId, destinationId);
	if (!sections) throw notFound();
	const section = parseIssueSection(sections);
	if (section.source.user_id !== actor.userId || section.destination.user_id !== actor.userId) {
		throw notFound();
	}
	if (
		section.issue.project_id !== payload.s ||
		section.issue.project_assignment_token !== payload.a
	) {
		throw new ApiFail(409, 'transfer_conflict', 'The issue has already moved; start again', {
			current_ref: `${section.source.name}/${section.issue.number}`
		});
	}
	const hashes = await hashTransferWitness(sections);
	if (
		hashes.issue !== payload.h.issue ||
		hashes.context !== payload.h.context ||
		hashes.routing !== payload.h.routing
	) {
		throw new ApiFail(
			409,
			'transfer_preview_stale',
			'The issue or transfer configuration changed; refresh and confirm again'
		);
	}
	const run = await activeRun(db, issueId);
	const blockers = blockersFor(actor, section, run);
	if (blockers.length) {
		const blocker = blockers[0];
		throw new ApiFail(blocker.code === 'issue_busy' ? 409 : 422, blocker.code, blocker.message, {
			run_id: blocker.run_id,
			status: blocker.run_status,
			remedy: blocker.remedy
		});
	}
	const oldRef = transferRef(section.source, payload.n);
	const source = transferProject(section.source);
	const destination = transferProject(section.destination);
	if (payload.s === payload.d) {
		// A same-project confirmation writes nothing: no number, no event, no
		// token rotation. It is deliberately not an error.
		return {
			status: 'noop',
			issue_id: issueId,
			source,
			destination,
			old_ref: oldRef,
			new_ref: oldRef,
			event_id: null,
			issue_path: `/issues/${encodeURIComponent(section.source.name)}/${payload.n}`,
			preserved: payload.r.preserved,
			context_changes: payload.r.context_changes,
			routing: payload.r.routing,
			schedule: payload.r.schedule
		};
	}

	const batch = transferIssueQueries(db, actor, payload, sections, now);
	const results = await runAtomic(env, batch.queries);
	const receiptRows = results[3]?.results;
	if (!Array.isArray(receiptRows)) {
		throw new Error('Issue transfer batch returned no receipt result');
	}
	if (receiptRows.length === 0) {
		throw new ApiFail(
			409,
			'transfer_preview_stale',
			'The issue or transfer configuration changed during commit; refresh and confirm again'
		);
	}
	const receipt = receiptRows[0] as Partial<{
		issue_id: string;
		project_id: string;
		project_name: string;
		number: number;
		event_id: string;
	}>;
	if (
		receiptRows.length !== 1 ||
		receipt.issue_id !== issueId ||
		receipt.project_id !== destinationId ||
		receipt.event_id !== batch.eventId ||
		!receipt.project_name ||
		!Number.isInteger(receipt.number) ||
		(receipt.number ?? 0) < 1
	) {
		throw new Error('Issue transfer committed with a malformed receipt');
	}
	effects?.signalDispatch();
	const newRef = transferRef(
		{ ...section.destination, name: receipt.project_name },
		receipt.number as number
	);
	return {
		status: 'transferred',
		issue_id: issueId,
		source,
		destination,
		old_ref: oldRef,
		new_ref: newRef,
		event_id: batch.eventId,
		issue_path: `/issues/${encodeURIComponent(newRef.project_name)}/${newRef.number}`,
		preserved: payload.r.preserved,
		context_changes: payload.r.context_changes,
		routing: payload.r.routing,
		schedule: payload.r.schedule
	};
}
