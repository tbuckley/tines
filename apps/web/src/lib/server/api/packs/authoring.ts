/**
 * Authored packs and the per-project operations every pack has (docs/packs.md):
 * create, edit, copy workflows in, add items, suggest schedules, set input
 * values and secrets, detach and remove.
 *
 * Every authored edit is checked the way an export would be: the pack's
 * content plus the edit is written out as files and parsed again, so an edit
 * the format would refuse (a placeholder naming no input, a duplicate key) is
 * refused here with the same messages `tines packs validate` prints.
 */
import {
	PACK_KEY_PATTERN,
	type AddPackWorkflowRequest,
	type CreatePackItemRequest,
	type CreatePackRequest,
	type MovePackIssuesRequest,
	type PackDetail,
	type PackInputDecl,
	type PackInputValueInput,
	type PackLocation,
	type PackModel,
	type PackRecurrence,
	type PackRemovePreview,
	type PackSchedule,
	type SchedulePreset,
	type SuggestPackScheduleRequest,
	type UpdatePackRequest,
	WEEKDAY_NAMES
} from '@tines/shared';
import { parsePack, writePackFiles } from '@tines/shared/packs';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database, type PackRow } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from '../core';
import { eventInsert } from '../events';
import { isJournal, resolveStateChain } from '../context';
import { packInputRefs } from '../pack-items';
import { projectOrgExpr } from '../org-core';
import { assertWorkflowIdInProject } from '../pack-items';
import { loadWorkflow, uniqueKey } from '../workflows';
import { assertAuthored, loadPack, packProject, revisionConflict } from './access';
import { randomPackKey } from './install';
import {
	packItemInsertQueries,
	packModelFromDb,
	packScheduleInsertQueries,
	stateRef
} from './model';
import { renderContextFor, scheduleFromSuggestionQueries, takenScheduleNames } from './schedules';
import { packDetail } from './views';
import { resolveValues, secretWriteQueries, valueWriteQueries } from './values';

async function detailFor(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	packId: string,
	viewerId: string
): Promise<PackDetail> {
	return packDetail(db, actor, await loadPack(db, projectId, packId), viewerId);
}

/** Refuses an authored edit whose result would not be a valid pack. */
async function assertValidAfter(model: PackModel): Promise<void> {
	const parsed = await parsePack(writePackFiles(model));
	if (parsed.errors.length)
		throw new ApiFail(422, 'invalid_pack', parsed.errors[0].message, { errors: parsed.errors });
}

function guardRevision(pack: PackRow, expected: unknown): void {
	if (expected !== undefined && expected !== pack.revision) throw revisionConflict(pack);
}

/** Bumps the pack's revision in the same batch, refusing the batch if another write got there first. */
function claimRevision(db: Kysely<Database>, pack: PackRow, now: number): CompiledQuery[] {
	return [
		sql`SELECT CASE WHEN EXISTS (SELECT 1 FROM pack WHERE id = ${pack.id} AND revision = ${pack.revision})
			THEN 1 ELSE json_extract('x', '$[') END`.compile(db),
		db
			.updateTable('pack')
			.set({ revision: pack.revision + 1, updated_at: now })
			.where('id', '=', pack.id)
			.compile()
	];
}

async function runClaimed(
	db: Kysely<Database>,
	env: Env,
	projectId: string,
	pack: PackRow,
	queries: CompiledQuery[]
): Promise<void> {
	try {
		await runAtomic(env, queries);
	} catch (e) {
		const fresh = await loadPack(db, projectId, pack.id);
		if (fresh.revision !== pack.revision) throw revisionConflict(fresh);
		throw e;
	}
}

// ---------------------------------------------------------------------------
// Create and edit

export async function createPack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: CreatePackRequest
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.create');
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	if (!name || name.length > 100)
		throw new ApiFail(422, 'invalid_field', 'A pack needs a name of at most 100 characters', {
			field: 'name'
		});
	const description = typeof body.description === 'string' ? body.description.slice(0, 2000) : '';
	const now = Date.now();
	const id = newId('pack');
	const max = await db
		.selectFrom('pack')
		.select((eb) => eb.fn.max('position').as('p'))
		.where('project_id', '=', projectId)
		.executeTakeFirst();
	await runAtomic(env, [
		db
			.insertInto('pack')
			.values({
				id,
				project_id: projectId,
				organization_id: null,
				pack_key: randomPackKey(),
				name,
				description,
				kind: 'authored',
				version: null,
				digest: null,
				source_kind: null,
				source_pack_id: null,
				derived_from: null,
				position: Number(max?.p ?? -1) + 1,
				inputs: '{}',
				readme: null,
				changelog: null,
				migrations: '{}',
				created_by: pp.personId,
				created_at: now,
				updated_at: now
			})
			.compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.created',
			projectId,
			createdAt: now,
			payload: { pack_id: id, name }
		})
	]);
	return detailFor(db, pp.actor, projectId, id, pp.personId);
}

export async function getPack(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	packId: string
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.read');
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

export async function updatePack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: UpdatePackRequest
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	guardRevision(pack, body.expected_revision);
	assertAuthored(pack, 'Editing a pack');
	const model = await packModelFromDb(db, pack);
	const next: PackModel = {
		...model,
		manifest: {
			...model.manifest,
			...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
			...(body.description !== undefined ? { description: String(body.description) } : {}),
			...(body.inputs !== undefined ? { inputs: body.inputs } : {})
		},
		readme: body.readme !== undefined ? body.readme : model.readme,
		changelog: body.changelog !== undefined ? body.changelog : model.changelog
	};
	await assertValidAfter(next);
	const now = Date.now();
	const queries = [
		...claimRevision(db, pack, now),
		db
			.updateTable('pack')
			.set({
				name: next.manifest.name,
				description: next.manifest.description,
				inputs: JSON.stringify(next.manifest.inputs),
				readme: next.readme,
				changelog: next.changelog
			})
			.where('id', '=', pack.id)
			.compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.updated',
			projectId,
			createdAt: now,
			payload: { pack_id: pack.id, name: next.manifest.name }
		})
	];
	if (body.inputs !== undefined) {
		// Values of inputs that went away (or changed type) go with them.
		const prev = model.manifest.inputs;
		const gone = Object.keys(prev).filter(
			(n) => !body.inputs![n] || body.inputs![n].type !== prev[n].type
		);
		if (gone.length)
			queries.push(
				db
					.deleteFrom('pack_input_value')
					.where('pack_id', '=', pack.id)
					.where('name', 'in', gone)
					.compile(),
				db
					.deleteFrom('contributor_secret')
					.where('pack_id', '=', pack.id)
					.where('input_name', 'in', gone)
					.compile()
			);
	}
	await runClaimed(db, env, projectId, pack, queries);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

// ---------------------------------------------------------------------------
// Workflows

/**
 * Copies a workflow used in this project into an authored pack: its states,
 * transitions, run scopes and the context on its states (not journals). An
 * inheriting state is flattened: its bases' context becomes its own.
 */
export async function addPackWorkflow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: AddPackWorkflowRequest
): Promise<PackDetail & { skipped: { name: string; reason: string }[] }> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	assertAuthored(pack, 'Adding a workflow');
	if (typeof body?.copy_from !== 'string')
		throw new ApiFail(422, 'invalid_field', 'Name the workflow to copy in "copy_from"', {
			field: 'copy_from'
		});
	const source = await loadWorkflow(db, pp.actor.userId, body.copy_from);
	await assertWorkflowIdInProject(db, source.id, projectId, 'copy_from');
	if (source.pack?.id === pack.id)
		throw new ApiFail(422, 'already_in_pack', `"${source.name}" is already in this pack`);
	const model = await packModelFromDb(db, pack);
	const takenWorkflowKeys = new Set(model.workflows.map((w) => w.key));
	let wfKey: string;
	if (body.key !== undefined) {
		if (!PACK_KEY_PATTERN.test(body.key) || takenWorkflowKeys.has(body.key))
			throw new ApiFail(422, 'invalid_field', `"${body.key}" is not an unused workflow key`, {
				field: 'key'
			});
		wfKey = body.key;
	} else wfKey = uniqueKey(source.name, takenWorkflowKeys);
	const stateKeys = new Set<string>();
	const keyOf = new Map(source.states.map((s) => [s.id, uniqueKey(s.name, stateKeys)]));
	const next: PackModel = {
		...model,
		workflows: [
			...model.workflows,
			{
				key: wfKey,
				name: source.name,
				description: source.description,
				initial: keyOf.get(source.initial_state_id)!,
				states: source.states.map((s) => ({
					key: keyOf.get(s.id)!,
					name: s.name,
					category: s.category,
					run_scope: s.run_scope === 'workspace' ? 'organization' : (s.run_scope ?? 'issue'),
					transitions: source.transitions
						.filter((t) => t.from_state_id === s.id)
						.map((t) => ({
							name: t.name,
							to: keyOf.get(t.to_state_id)!,
							...(t.requires?.length ? { requires: t.requires } : {})
						}))
				}))
			}
		]
	};
	// State context: each state's own and its bases' items (leaf wins a name), not journals.
	const skipped: { name: string; reason: string }[] = [];
	const additions: PackModel = {
		...next,
		prompts: [],
		skills: [],
		env: [],
		repos: [],
		schedules: []
	};
	for (const s of source.states) {
		const chain = await resolveStateChain(db, s.id);
		const rows = await db
			.selectFrom('context_item')
			.selectAll()
			.where('user_id', '=', pp.actor.userId)
			.where('workflow_state_id', 'in', chain)
			.where('label_id', 'is', null)
			.where('issue_id', 'is', null)
			.where('pack_id', 'is', null)
			.where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', '=', projectId)]))
			.where('kind', 'in', ['prompt', 'skill', 'env', 'repo'])
			.execute();
		rows.sort(
			(a, b) =>
				chain.indexOf(a.workflow_state_id!) - chain.indexOf(b.workflow_state_id!) ||
				(a.project_id ? 1 : 0) - (b.project_id ? 1 : 0) ||
				a.position - b.position
		);
		const byName = new Map<string, (typeof rows)[number]>();
		for (const r of rows) {
			if (isJournal(r)) continue;
			byName.set(`${r.kind}\0${r.name}`, r);
		}
		const loc: PackLocation = { reach: 'state', workflow: wfKey, state: keyOf.get(s.id)! };
		for (const r of byName.values()) {
			if (r.kind === 'prompt')
				additions.prompts.push({
					...loc,
					name: r.name,
					description: r.description,
					order: r.position,
					body: r.body ?? ''
				});
			else if (r.kind === 'skill') {
				const files = await db
					.selectFrom('context_item_file')
					.select(['path', 'content'])
					.where('context_item_id', '=', r.id)
					.orderBy('path')
					.execute();
				additions.skills.push({ ...loc, name: r.name, description: r.description, files });
			} else if (r.kind === 'env') {
				if (r.env_value_enc !== null) {
					skipped.push({
						name: r.name,
						reason: 'secret env values are never copied into a pack; declare a secret input instead'
					});
					continue;
				}
				additions.env.push({ ...loc, name: r.name, value: { template: r.env_value ?? '' } });
			} else if (r.kind === 'repo')
				additions.repos.push({
					...loc,
					name: r.name,
					input: null,
					url: r.repo_url,
					branch: r.repo_branch,
					dir: r.repo_dir
				});
		}
	}
	await assertValidAfter({
		...next,
		prompts: [...next.prompts, ...additions.prompts],
		skills: [...next.skills, ...additions.skills],
		env: [...next.env, ...additions.env],
		repos: [...next.repos, ...additions.repos]
	});
	const now = Date.now();
	const wfId = newId('wf');
	const ids = { workflows: new Map([[wfKey, wfId]]), states: new Map<string, string>() };
	const nw = next.workflows[next.workflows.length - 1];
	for (const st of nw.states) ids.states.set(stateRef(wfKey, st.key), newId('wfs'));
	const queries: CompiledQuery[] = [
		...claimRevision(db, pack, now),
		db
			.insertInto('workflow')
			.values({
				id: wfId,
				user_id: pp.actor.userId,
				name: nw.name,
				description: nw.description,
				initial_state_id: ids.states.get(stateRef(wfKey, nw.initial))!,
				pack_id: pack.id,
				key: wfKey,
				organization_id: projectOrgExpr(projectId),
				created_at: now,
				updated_at: now
			})
			.compile(),
		...nw.states.map((st, position) =>
			db
				.insertInto('workflow_state')
				.values({
					id: ids.states.get(stateRef(wfKey, st.key))!,
					workflow_id: wfId,
					name: st.name,
					category: st.category,
					position,
					run_scope: st.run_scope === 'organization' ? 'workspace' : st.run_scope,
					key: st.key,
					created_at: now
				})
				.compile()
		),
		...nw.states.flatMap((st) =>
			st.transitions.map((t) =>
				db
					.insertInto('workflow_transition')
					.values({
						id: newId('wft'),
						workflow_id: wfId,
						name: t.name,
						from_state_id: ids.states.get(stateRef(wfKey, st.key))!,
						to_state_id: ids.states.get(stateRef(wfKey, t.to))!,
						requirements: t.requires?.length ? JSON.stringify(t.requires) : null
					})
					.compile()
			)
		),
		...packItemInsertQueries(db, additions, {
			ownerId: pp.actor.userId,
			projectId,
			packId: pack.id,
			ids,
			now
		}),
		eventInsert(db, pp.actor, {
			type: 'workflow.created',
			createdAt: now,
			payload: { workflow_id: wfId, name: nw.name, pack_id: pack.id, copied_from: source.id }
		})
	];
	await runClaimed(db, env, projectId, pack, queries);
	return { ...(await detailFor(db, pp.actor, projectId, packId, pp.personId)), skipped };
}

/**
 * The state mapping for moving a workflow's issues and schedules onto a pack
 * workflow: each source state with what it holds, pre-filled by state name.
 */
export async function moveIssuesPreview(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	packId: string,
	fromWorkflowId: string,
	toWorkflowId: string
) {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.read');
	const pack = await loadPack(db, projectId, packId);
	const [from, to] = await Promise.all([
		loadWorkflow(db, pp.actor.userId, fromWorkflowId),
		loadWorkflow(db, pp.actor.userId, toWorkflowId)
	]);
	if (to.pack?.id !== pack.id) throw notFound();
	const counts = await Promise.all(
		from.states.map(async (s) => {
			const [issues, schedules] = await Promise.all([
				db
					.selectFrom('issue')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('state_id', '=', s.id)
					.where('project_id', '=', projectId)
					.executeTakeFirst(),
				db
					.selectFrom('scheduled_task')
					.select((eb) => eb.fn.countAll<number>().as('n'))
					.where('project_id', '=', projectId)
					.where((eb) =>
						eb.or([
							eb('state_id', '=', s.id),
							...(s.id === from.initial_state_id
								? [eb.and([eb('workflow_id', '=', from.id), eb('state_id', 'is', null)])]
								: [])
						])
					)
					.executeTakeFirst()
			]);
			const byName = to.states.find((t) => t.name.toLowerCase() === s.name.toLowerCase());
			return {
				state_id: s.id,
				state_name: s.name,
				issues: Number(issues?.n ?? 0),
				schedules: Number(schedules?.n ?? 0),
				suggested: byName?.id ?? null
			};
		})
	);
	return {
		from: { id: from.id, name: from.name },
		to: { id: to.id, name: to.name, states: to.states.map((s) => ({ id: s.id, name: s.name })) },
		states: counts
	};
}

/**
 * Moves this project's issues and schedules from a workflow onto a pack
 * workflow, through a state mapping. Only this project's: other projects
 * that use the original keep it (decided 2026-10-04). Run permission is kept.
 */
export async function movePackIssues(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	toWorkflowId: string,
	body: MovePackIssuesRequest
): Promise<{ issues_moved: number; schedules_moved: number }> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const preview = await moveIssuesPreview(
		db,
		actor,
		projectId,
		packId,
		body.from_workflow_id,
		toWorkflowId
	);
	const targets = new Set(preview.to.states.map((s) => s.id));
	const now = Date.now();
	const queries: CompiledQuery[] = [];
	let issues = 0;
	let schedules = 0;
	for (const s of preview.states) {
		if (s.issues + s.schedules === 0) continue;
		const target = body.state_mapping?.[s.state_id] ?? s.suggested;
		if (!target || !targets.has(target))
			throw new ApiFail(
				422,
				'state_mapping_required',
				`Map "${s.state_name}" to a state of "${preview.to.name}"`,
				{
					state_id: s.state_id
				}
			);
		issues += s.issues;
		schedules += s.schedules;
		queries.push(
			db
				.updateTable('issue')
				.set({
					workflow_id: toWorkflowId,
					state_id: target,
					state_entered_at: now,
					updated_at: now,
					decision_revision: sql`decision_revision + 1`
				})
				.where('state_id', '=', s.state_id)
				.where('project_id', '=', projectId)
				.compile(),
			db
				.updateTable('scheduled_task')
				.set({ workflow_id: toWorkflowId, state_id: target, updated_at: now })
				.where('project_id', '=', projectId)
				.where((eb) =>
					eb.or([
						eb('state_id', '=', s.state_id),
						eb.and([eb('workflow_id', '=', preview.from.id), eb('state_id', 'is', null)])
					])
				)
				.compile()
		);
	}
	if (queries.length) {
		queries.push(
			db
				.updateTable('project')
				.set({ default_workflow_id: toWorkflowId })
				.where('id', '=', projectId)
				.where('default_workflow_id', '=', preview.from.id)
				.compile(),
			eventInsert(db, pp.actor, {
				type: 'pack.updated',
				projectId,
				createdAt: now,
				payload: {
					pack_id: packId,
					name: preview.to.name,
					moved_from: preview.from.name,
					issues_moved: issues
				}
			})
		);
		await runAtomic(env, queries);
	}
	return { issues_moved: issues, schedules_moved: schedules };
}

// ---------------------------------------------------------------------------
// Items

export async function createPackItem(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: CreatePackItemRequest
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	assertAuthored(pack, 'Adding context');
	const model = await packModelFromDb(db, pack);
	const loc = await itemLocation(db, pack, body);
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	const empty: PackModel = { ...model, prompts: [], skills: [], env: [], repos: [], schedules: [] };
	switch (body.kind) {
		case 'prompt':
			empty.prompts.push({
				...loc,
				name,
				description: body.description ?? '',
				order: Number.isInteger(body.order) ? body.order! : 100,
				body: body.body ?? ''
			});
			break;
		case 'skill':
			empty.skills.push({
				...loc,
				name,
				description: body.description ?? '',
				files: body.files ?? []
			});
			break;
		case 'env':
			empty.env.push({
				...loc,
				name,
				value: body.input ? { input: body.input } : { template: body.value ?? '' }
			});
			break;
		case 'repo':
			empty.repos.push({
				...loc,
				name,
				input: body.input ?? null,
				url: body.input ? null : (body.repo_url ?? null),
				branch: body.input ? null : (body.repo_branch ?? null),
				dir: body.repo_dir ?? null
			});
			break;
		default:
			throw new ApiFail(422, 'invalid_field', 'kind must be prompt, skill, env or repo', {
				field: 'kind'
			});
	}
	await assertValidAfter({
		...model,
		prompts: [...model.prompts, ...empty.prompts],
		skills: [...model.skills, ...empty.skills],
		env: [...model.env, ...empty.env],
		repos: [...model.repos, ...empty.repos]
	});
	const ids = await packIds(db, pack.id);
	const now = Date.now();
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		...packItemInsertQueries(db, empty, {
			ownerId: pp.actor.userId,
			projectId,
			packId: pack.id,
			ids,
			now
		})
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

async function itemLocation(
	db: Kysely<Database>,
	pack: PackRow,
	body: CreatePackItemRequest
): Promise<PackLocation> {
	switch (body.reach) {
		case 'project':
		case 'pack':
			return { reach: body.reach, workflow: null, state: null };
		case 'workflow': {
			const wf = await db
				.selectFrom('workflow')
				.select('key')
				.where('id', '=', body.workflow_id ?? '')
				.where('pack_id', '=', pack.id)
				.executeTakeFirst();
			if (!wf?.key)
				throw new ApiFail(422, 'invalid_field', 'workflow_id must be a workflow of this pack', {
					field: 'workflow_id'
				});
			return { reach: 'workflow', workflow: wf.key, state: null };
		}
		case 'state': {
			const st = await db
				.selectFrom('workflow_state')
				.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
				.select(['workflow_state.key as state_key', 'workflow.key as workflow_key'])
				.where('workflow_state.id', '=', body.state_id ?? '')
				.where('workflow.pack_id', '=', pack.id)
				.executeTakeFirst();
			if (!st?.state_key || !st.workflow_key)
				throw new ApiFail(422, 'invalid_field', 'state_id must be a state of this pack', {
					field: 'state_id'
				});
			return { reach: 'state', workflow: st.workflow_key, state: st.state_key };
		}
		default:
			throw new ApiFail(422, 'invalid_field', 'reach must be project, pack, workflow or state', {
				field: 'reach'
			});
	}
}

async function packIds(db: Kysely<Database>, packId: string) {
	const rows = await db
		.selectFrom('workflow_state')
		.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
		.select([
			'workflow.id as workflow_id',
			'workflow.key as workflow_key',
			'workflow_state.id',
			'workflow_state.key'
		])
		.where('workflow.pack_id', '=', packId)
		.execute();
	const ids = { workflows: new Map<string, string>(), states: new Map<string, string>() };
	for (const r of rows) {
		if (r.workflow_key) ids.workflows.set(r.workflow_key, r.workflow_id);
		if (r.workflow_key && r.key) ids.states.set(stateRef(r.workflow_key, r.key), r.id);
	}
	return ids;
}

/** Moves one of the project's own project-scoped items into an authored pack's `project/` reach. */
export async function moveItemIntoPack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	itemId: string
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	assertAuthored(pack, 'Adding context');
	const item = await db
		.selectFrom('context_item')
		.selectAll()
		.where('id', '=', itemId)
		.where('user_id', '=', pp.actor.userId)
		.executeTakeFirst();
	if (!item) throw notFound();
	if (
		item.project_id !== projectId ||
		item.workflow_state_id ||
		item.label_id ||
		item.issue_id ||
		item.pack_id ||
		!['prompt', 'skill', 'env', 'repo'].includes(item.kind)
	)
		throw new ApiFail(
			422,
			'not_project_item',
			"Only the project's own project-wide prompts, skills, env and repo items can move into a pack"
		);
	if (item.kind === 'env' && item.env_value_enc !== null)
		throw new ApiFail(
			422,
			'pack_secret_value',
			'A secret env item cannot move into a pack; declare a secret input instead'
		);
	const decls = (await packModelFromDb(db, pack)).manifest.inputs;
	const files =
		item.kind === 'skill'
			? await db
					.selectFrom('context_item_file')
					.select(['path', 'content'])
					.where('context_item_id', '=', item.id)
					.execute()
			: [];
	const refs = packInputRefs(
		decls,
		[
			item.body,
			item.kind === 'env' ? item.env_value : null,
			...files.filter((f) => f.path.endsWith('.md')).map((f) => f.content)
		],
		null
	);
	const clash = await db
		.selectFrom('context_item')
		.select('id')
		.where('pack_id', '=', pack.id)
		.where('reach', '=', 'project')
		.where('kind', '=', item.kind)
		.where('name', '=', item.name)
		.executeTakeFirst();
	if (clash)
		throw new ApiFail(
			422,
			'duplicate_context_name',
			`The pack already has a project-wide ${item.kind} "${item.name}"`
		);
	const now = Date.now();
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		db
			.updateTable('context_item')
			.set({
				pack_id: pack.id,
				reach: 'project',
				input_refs: refs.length ? JSON.stringify(refs) : null,
				version: sql`version + 1`,
				updated_at: now
			})
			.where('id', '=', item.id)
			.where('version', '=', item.version)
			.compile()
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

// ---------------------------------------------------------------------------
// Values and secrets

export async function setPackValues(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: { values?: Record<string, PackInputValueInput | null> }
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.values');
	const pack = await loadPack(db, projectId, packId);
	const model = await packModelFromDb(db, pack);
	const ids = await packIds(db, pack.id);
	const keys = new Map(
		model.workflows.map((w) => [
			w.key,
			{
				id: ids.workflows.get(w.key)!,
				states: new Map(w.states.map((s) => [s.key, ids.states.get(stateRef(w.key, s.key))!]))
			}
		])
	);
	const resolved = await resolveValues(
		db,
		pp.actor.userId,
		projectId,
		model.manifest.inputs,
		body?.values,
		keys
	);
	const now = Date.now();
	await runAtomic(env, [
		...valueWriteQueries(db, pack.id, resolved, now),
		eventInsert(db, pp.actor, {
			type: 'pack.updated',
			projectId,
			createdAt: now,
			payload: {
				pack_id: pack.id,
				name: pack.name,
				values_changed: [...resolved.upserts.map((u) => u.name), ...resolved.clears]
			}
		})
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

/** The caller's own values for secret inputs. Nobody else's are ever read or written. */
export async function setMySecrets(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: { secrets?: Record<string, string | null> }
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.secrets');
	if (pp.actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot set secret values');
	const pack = await loadPack(db, projectId, packId);
	const decls = (await packModelFromDb(db, pack)).manifest.inputs;
	await runAtomic(
		env,
		await secretWriteQueries(db, env, pack.id, pp.personId, decls, body?.secrets, Date.now())
	);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

// ---------------------------------------------------------------------------
// Suggested schedules

function presetToRecurrence(preset: SchedulePreset | null, cron: string): PackRecurrence {
	if (!preset) return { cron };
	switch (preset.kind) {
		case 'hourly':
			return {
				every: preset.every_hours && preset.every_hours > 1 ? `${preset.every_hours}h` : 'hourly',
				...(preset.minute ? { at: `:${String(preset.minute).padStart(2, '0')}` } : {})
			} as PackRecurrence;
		case 'daily':
			return { every: 'daily', at: preset.time };
		case 'weekly':
			return {
				every: 'weekly',
				on: WEEKDAY_NAMES[preset.weekday ?? 1].slice(0, 3).toLowerCase(),
				at: preset.time
			};
		case 'monthly':
			return { every: 'monthly', on: preset.day_of_month, at: preset.time };
	}
}

/** Suggest in pack: copies an existing schedule on one of the pack's workflows into the pack. */
export async function suggestPackSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: SuggestPackScheduleRequest
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	assertAuthored(pack, 'Suggesting a schedule');
	const schedule = await db
		.selectFrom('scheduled_task')
		.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
		.leftJoin('workflow_state', 'workflow_state.id', 'scheduled_task.state_id')
		.select([
			'scheduled_task.id',
			'scheduled_task.name',
			'scheduled_task.title_template',
			'scheduled_task.description_template',
			'scheduled_task.cron',
			'scheduled_task.preset',
			'scheduled_task.require_all_closed',
			'workflow.key as workflow_key',
			'workflow.pack_id',
			'workflow_state.key as state_key'
		])
		.where('scheduled_task.id', '=', body?.schedule_id ?? '')
		.where('scheduled_task.project_id', '=', projectId)
		.executeTakeFirst();
	if (!schedule) throw notFound();
	if (schedule.pack_id !== pack.id || !schedule.workflow_key)
		throw new ApiFail(
			422,
			'not_pack_workflow',
			"Only a schedule on one of this pack's workflows can be suggested"
		);
	const model = await packModelFromDb(db, pack);
	const taken = new Set(model.schedules.map((s) => s.key));
	const key = body.key ?? uniqueKey(schedule.name, taken);
	if (body.key !== undefined && (taken.has(key) || !PACK_KEY_PATTERN.test(key)))
		throw new ApiFail(422, 'invalid_field', `"${key}" is not an unused suggestion key`, {
			field: 'key'
		});
	const suggestion: PackSchedule = {
		key,
		name: schedule.name,
		workflow: schedule.workflow_key,
		start: schedule.state_key,
		recurrence: presetToRecurrence(
			schedule.preset ? JSON.parse(schedule.preset) : null,
			schedule.cron
		),
		only_when_previous_closed: schedule.require_all_closed === 1,
		title: schedule.title_template,
		description: schedule.description_template
	};
	await assertValidAfter({ ...model, schedules: [...model.schedules, suggestion] });
	const now = Date.now();
	const id = newId('psch');
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		...packScheduleInsertQueries(db, pack.id, [suggestion], new Map([[key, id]])).map((q) => q),
		db
			.updateTable('pack_schedule')
			.set({ position: model.schedules.length })
			.where('id', '=', id)
			.compile(),
		db
			.updateTable('scheduled_task')
			.set({ pack_schedule_id: id })
			.where('id', '=', schedule.id)
			.compile()
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

export async function removePackSuggestion(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	key: string
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.update');
	const pack = await loadPack(db, projectId, packId);
	assertAuthored(pack, 'Removing a suggestion');
	const row = await db
		.selectFrom('pack_schedule')
		.select('id')
		.where('pack_id', '=', pack.id)
		.where('schedule_key', '=', key)
		.executeTakeFirst();
	if (!row) throw notFound();
	const now = Date.now();
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		db
			.updateTable('scheduled_task')
			.set({ pack_schedule_id: null })
			.where('pack_schedule_id', '=', row.id)
			.compile(),
		db.deleteFrom('pack_schedule').where('id', '=', row.id).compile()
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

/** Set up: creates an ordinary, enabled project schedule from a suggestion. */
export async function setUpPackSchedule(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	key: string,
	body: { timezone?: unknown }
): Promise<{ id: string; name: string }> {
	const pp = await packProject(db, actor, projectId, 'write', 'schedule.create');
	const pack = await loadPack(db, projectId, packId);
	const model = await packModelFromDb(db, pack);
	const suggestion = model.schedules.find((s) => s.key === key);
	const row = await db
		.selectFrom('pack_schedule')
		.select('id')
		.where('pack_id', '=', pack.id)
		.where('schedule_key', '=', key)
		.executeTakeFirst();
	if (!suggestion || !row) throw notFound();
	const ids = await packIds(db, pack.id);
	const workflowId = ids.workflows.get(suggestion.workflow);
	if (!workflowId)
		throw new ApiFail(
			409,
			'pack_workflow_missing',
			`The pack has no workflow "${suggestion.workflow}"`
		);
	const values = await db
		.selectFrom('pack_input_value')
		.selectAll()
		.where('pack_id', '=', pack.id)
		.execute();
	const ctx = await renderContextFor(
		db,
		{ id: pack.id, name: pack.name, projectName: pp.project.name, inputs: model.manifest.inputs },
		values,
		new Map()
	);
	// A workflow input left to its default renders the pack's own workflow.
	for (const [name, decl] of Object.entries(model.manifest.inputs))
		if (decl.type === 'workflow' && decl.default && !values.some((v) => v.name === name)) {
			const [wfKey, stKey] = decl.default.split('/');
			const wf = model.workflows.find((w) => w.key === wfKey);
			if (wf)
				ctx.packs.get(pack.id)!.workflows.set(name, {
					id: ids.workflows.get(wfKey)!,
					name: wf.name,
					stateName: wf.states.find((s) => s.key === (stKey ?? wf.initial))?.name ?? ''
				});
		}
	const now = Date.now();
	const out = scheduleFromSuggestionQueries(db, pp.actor, {
		projectId,
		packId: pack.id,
		packScheduleId: row.id,
		suggestion,
		workflowId,
		stateId: suggestion.start
			? (ids.states.get(stateRef(suggestion.workflow, suggestion.start)) ?? null)
			: null,
		timezone: body?.timezone,
		ctx,
		takenNames: await takenScheduleNames(db, projectId),
		now
	});
	await runAtomic(env, out.queries);
	return { id: out.id, name: out.name };
}

// ---------------------------------------------------------------------------
// Detach and remove

export async function detachPack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: { expected_revision?: number }
): Promise<PackDetail> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.detach');
	const pack = await loadPack(db, projectId, packId);
	guardRevision(pack, body?.expected_revision);
	if (pack.kind !== 'installed')
		throw new ApiFail(422, 'not_installed', 'Only an installed pack can be detached');
	const now = Date.now();
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		db
			.updateTable('pack')
			.set({
				kind: 'authored',
				pack_key: randomPackKey(),
				version: null,
				digest: null,
				source_kind: null,
				source_pack_id: null,
				derived_from: JSON.stringify({ id: pack.pack_key, version: pack.version })
			})
			.where('id', '=', pack.id)
			.compile(),
		db.deleteFrom('pack_snapshot_file').where('pack_id', '=', pack.id).compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.detached',
			projectId,
			createdAt: now,
			payload: {
				pack_id: pack.id,
				name: pack.name,
				from: { id: pack.pack_key, version: pack.version }
			}
		})
	]);
	return detailFor(db, pp.actor, projectId, packId, pp.personId);
}

export async function removePreview(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	packId: string
): Promise<PackRemovePreview> {
	await packProject(db, actor, projectId, 'read', 'pack.read');
	const pack = await loadPack(db, projectId, packId);
	const workflowIds = (
		await db.selectFrom('workflow').select('id').where('pack_id', '=', pack.id).execute()
	).map((w) => w.id);
	const ids = workflowIds.concat(['']);
	const [issues, schedules, additions, bindings] = await Promise.all([
		db
			.selectFrom('issue')
			.innerJoin('project', 'project.id', 'issue.project_id')
			.select(['issue.id', 'issue.number', 'project.name as project_name'])
			.where('issue.workflow_id', 'in', ids)
			.orderBy('issue.number')
			.limit(200)
			.execute(),
		db
			.selectFrom('scheduled_task')
			.select(['id', 'name'])
			.where('workflow_id', 'in', ids)
			.execute(),
		db
			.selectFrom('context_item')
			.innerJoin('workflow_state', 'workflow_state.id', 'context_item.workflow_state_id')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select([
				'context_item.id',
				'context_item.kind',
				'context_item.name',
				'workflow.name as workflow_name',
				'workflow_state.name as state_name'
			])
			.where('workflow.pack_id', '=', pack.id)
			.where('context_item.pack_id', 'is', null)
			.execute(),
		db
			.selectFrom('pack_input_value')
			.innerJoin('pack', 'pack.id', 'pack_input_value.pack_id')
			.select(['pack.id', 'pack.name', 'pack_input_value.name as input'])
			.where('pack_input_value.workflow_id', 'in', ids)
			.where('pack.id', '!=', pack.id)
			.execute()
	]);
	return {
		blocked_by: {
			issues: issues.map((i) => ({ id: i.id, ref: `${i.project_name}/${i.number}` })),
			schedules
		},
		additions: additions.map((a) => ({
			id: a.id,
			kind: a.kind,
			name: a.name,
			scope_label: `state ${a.workflow_name} / ${a.state_name}`
		})),
		unbound_inputs: bindings.map((b) => ({ pack_id: b.id, pack_name: b.name, input: b.input }))
	};
}

export async function removePack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: { expected_revision?: number }
): Promise<{ removed: true; additions_deleted: number; inputs_unbound: number }> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.remove');
	const pack = await loadPack(db, projectId, packId);
	guardRevision(pack, body?.expected_revision);
	const preview = await removePreview(db, actor, projectId, packId);
	if (preview.blocked_by.issues.length || preview.blocked_by.schedules.length)
		throw new ApiFail(
			409,
			'pack_in_use',
			`${preview.blocked_by.issues.length} issue(s) and ${preview.blocked_by.schedules.length} schedule(s) use this pack's workflows; move them first`,
			preview.blocked_by as unknown as Record<string, unknown>
		);
	const workflowIds = (
		await db.selectFrom('workflow').select('id').where('pack_id', '=', pack.id).execute()
	).map((w) => w.id);
	const ids = workflowIds.concat(['']);
	const stateIds = db.selectFrom('workflow_state').select('id').where('workflow_id', 'in', ids);
	const now = Date.now();
	await runClaimed(db, env, projectId, pack, [
		...claimRevision(db, pack, now),
		// Project additions on the pack's states, and the pack's own items.
		db
			.deleteFrom('context_item_file')
			.where(
				'context_item_id',
				'in',
				db.selectFrom('context_item').select('id').where('workflow_state_id', 'in', stateIds)
			)
			.compile(),
		db.deleteFrom('context_item').where('workflow_state_id', 'in', stateIds).compile(),
		db
			.deleteFrom('context_item_file')
			.where(
				'context_item_id',
				'in',
				db.selectFrom('context_item').select('id').where('pack_id', '=', pack.id)
			)
			.compile(),
		db.deleteFrom('context_item').where('pack_id', '=', pack.id).compile(),
		db.deleteFrom('routing_rule').where('workflow_state_id', 'in', stateIds).compile(),
		db
			.updateTable('project')
			.set({ default_workflow_id: null })
			.where('default_workflow_id', 'in', ids)
			.compile(),
		db.deleteFrom('pack_input_value').where('workflow_id', 'in', ids).compile(),
		db.deleteFrom('workflow_transition').where('workflow_id', 'in', ids).compile(),
		db.deleteFrom('workflow_state').where('workflow_id', 'in', ids).compile(),
		db.deleteFrom('workflow').where('id', 'in', ids).compile(),
		db
			.updateTable('scheduled_task')
			.set({ pack_schedule_id: null })
			.where(
				'pack_schedule_id',
				'in',
				db.selectFrom('pack_schedule').select('id').where('pack_id', '=', pack.id)
			)
			.compile(),
		db.deleteFrom('pack_schedule').where('pack_id', '=', pack.id).compile(),
		db.deleteFrom('pack_input_value').where('pack_id', '=', pack.id).compile(),
		db.deleteFrom('contributor_secret').where('pack_id', '=', pack.id).compile(),
		db.deleteFrom('pack_snapshot_file').where('pack_id', '=', pack.id).compile(),
		db.deleteFrom('pack').where('id', '=', pack.id).compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.removed',
			projectId,
			createdAt: now,
			payload: { pack_id: pack.id, name: pack.name, version: pack.version }
		})
	]);
	return {
		removed: true,
		additions_deleted: preview.additions.length,
		inputs_unbound: preview.unbound_inputs.length
	};
}

export type { PackInputDecl };
