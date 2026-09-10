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
import { queueDispatchPass } from '$lib/server/supervisor/engine';

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

export interface PrivateIssueTransferPreview {
	issueId: string;
	source: WitnessProject;
	destination: WitnessProject;
	oldRef: string;
	noop: boolean;
	canCommit: boolean;
	blockers: Array<{ code: string; message: string; runId?: string; status?: string }>;
	previewToken: string | null;
}

export interface PrivateIssueTransferResult {
	status: 'transferred' | 'noop';
	issueId: string;
	oldRef: string;
	newRef: string;
	eventId: string | null;
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
	const result = await sql<{ issue_witness: string | null; context_witness: string }>`
		SELECT ${witness.issue} AS issue_witness, ${witness.context} AS context_witness
	`.execute(db);
	const row = result.rows[0];
	if (!row?.issue_witness) return null;
	return { issue: row.issue_witness, context: row.context_witness };
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
): PrivateIssueTransferPreview['blockers'] {
	const blockers: PrivateIssueTransferPreview['blockers'] = [];
	if (actor.agentRunId) {
		blockers.push({ code: 'run_key_forbidden', message: 'A run key cannot transfer an issue' });
	}
	if (section.source.archived_at !== null) {
		blockers.push({ code: 'project_archived', message: 'The source project is archived' });
	}
	if (section.destination.archived_at !== null) {
		blockers.push({ code: 'project_archived', message: 'The destination project is archived' });
	}
	if (run) {
		blockers.push({
			code: 'issue_busy',
			message: `Run ${run.id} is ${run.status}; wait for it to finish or cancel it separately`,
			runId: run.id,
			status: run.status
		});
	}
	return blockers;
}

export async function previewIssueTransfer(
	env: Env,
	actor: ActorContext,
	issueId: string,
	destinationId: string,
	now = Date.now()
): Promise<PrivateIssueTransferPreview> {
	const db = getDb(env);
	const sections = await readWitnessSections(db, issueId, destinationId);
	if (!sections) throw notFound();
	const section = parseIssueSection(sections);
	if (section.source.user_id !== actor.userId || section.destination.user_id !== actor.userId) {
		throw notFound();
	}
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
	const payload: TransferWitnessPayload = {
		v: 1,
		u: actor.userId,
		i: issueId,
		s: section.source.id,
		d: destinationId,
		a: section.issue.project_assignment_token,
		n: section.issue.number,
		e: now + TRANSFER_PREVIEW_TTL_MS,
		h: await hashTransferWitness(sections)
	};
	return {
		issueId,
		source: section.source,
		destination: section.destination,
		oldRef: `${section.source.name}/${section.issue.number}`,
		noop: section.source.id === section.destination.id,
		canCommit: blockers.length === 0,
		blockers,
		previewToken: blockers.length === 0 ? await mintTransferWitness(payload, keyMaterial) : null
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
		SELECT issue.id, issue.number, project.name AS project_name
		FROM issue JOIN project ON project.id = issue.project_id
		WHERE issue.id = ${payload.i} AND ${moved}
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
	platform?: { env: Env; ctx?: { waitUntil(promise: Promise<unknown>): void } }
): Promise<PrivateIssueTransferResult> {
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
	if (hashes.issue !== payload.h.issue || hashes.context !== payload.h.context) {
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
			run_id: blocker.runId,
			status: blocker.status
		});
	}
	const oldRef = `${section.source.name}/${payload.n}`;
	if (payload.s === payload.d) {
		return { status: 'noop', issueId, oldRef, newRef: oldRef, eventId: null };
	}

	const batch = transferIssueQueries(db, actor, payload, sections, now);
	const results = await runAtomic(env, batch.queries);
	if ((results[0]?.meta?.changes ?? 0) !== 1) {
		throw new ApiFail(
			409,
			'transfer_preview_stale',
			'The issue or transfer configuration changed during commit; refresh and confirm again'
		);
	}
	const receipt = results[3]?.results?.[0] as
		{ project_name?: string; number?: number } | undefined;
	if (!receipt?.project_name || typeof receipt.number !== 'number') {
		throw new Error('Issue transfer committed without a receipt');
	}
	// Canonical and historical reads are both exercised here so an allocator or
	// alias regression cannot masquerade as a successful mutation.
	await loadIssue(db, actor.userId, { projectName: section.source.name, number: payload.n });
	await loadIssue(db, actor.userId, { projectName: receipt.project_name, number: receipt.number });
	// Transfer has committed at this point. Opportunistic dispatch is best-effort:
	// the periodic sweep remains authoritative, so queue failures must never make
	// the caller believe the already-durable move failed.
	try {
		queueDispatchPass(platform, actor.userId);
	} catch (e) {
		console.error('could not queue dispatch after issue transfer:', e);
	}
	return {
		status: 'transferred',
		issueId,
		oldRef,
		newRef: `${receipt.project_name}/${receipt.number}`,
		eventId: batch.eventId
	};
}
