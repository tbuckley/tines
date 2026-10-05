/**
 * Writing a pack's workflows: on install every row is new; on Replace rows
 * are matched by key (after `migrations.yaml` renames), so workflow and state
 * ids — and the issues, schedules, routing rules and project additions that
 * point at them — survive. States the new version removes are emptied through
 * the reviewed state mapping, then deleted.
 */
import type { PackMigrationEntry, PackModel } from '@tines/shared';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { stateRef, storedRunScope, type PackIds } from './model';
import { projectOrgExpr } from '../org-core';

export interface ExistingPackWorkflows {
	workflows: {
		id: string;
		key: string;
		name: string;
		definition_revision: number;
	}[];
	states: { id: string; workflow_id: string; key: string; name: string }[];
	transitions: { id: string; workflow_id: string; from_state_id: string; name: string }[];
}

export async function loadExistingPackWorkflows(
	db: Kysely<Database>,
	packId: string
): Promise<ExistingPackWorkflows> {
	const workflows = await db
		.selectFrom('workflow')
		.select(['id', 'key', 'name', 'definition_revision'])
		.where('pack_id', '=', packId)
		.execute();
	const ids = workflows.map((w) => w.id).concat(['']);
	const [states, transitions] = await Promise.all([
		db
			.selectFrom('workflow_state')
			.select(['id', 'workflow_id', 'key', 'name'])
			.where('workflow_id', 'in', ids)
			.execute(),
		db
			.selectFrom('workflow_transition')
			.select(['id', 'workflow_id', 'from_state_id', 'name'])
			.where('workflow_id', 'in', ids)
			.execute()
	]);
	return {
		workflows: workflows.map((w) => ({ ...w, key: w.key ?? w.id })),
		states: states.map((s) => ({ ...s, key: s.key ?? s.id })),
		transitions
	};
}

/**
 * Renames that apply when going from `fromVersion` to the new version:
 * every `migrations.yaml` entry newer than `fromVersion`, chained in version
 * order. Returns old ref → new ref for workflows (`wf`) and states (`wf/st`).
 */
export function chainedRenames(
	migrations: Record<string, PackMigrationEntry>,
	fromVersion: number | null
): { renamed: Map<string, string>; removed: Map<string, string> } {
	const versions = Object.keys(migrations)
		.map(Number)
		.filter((v) => Number.isInteger(v) && v > (fromVersion ?? 0))
		.sort((a, b) => a - b);
	const renamed = new Map<string, string>();
	const removed = new Map<string, string>();
	for (const v of versions) {
		const entry = migrations[String(v)];
		for (const [from, to] of Object.entries(entry.renamed ?? {})) {
			// Chain: anything already renamed to `from` now goes to `to`.
			let chained = false;
			for (const [orig, cur] of renamed)
				if (cur === from) {
					renamed.set(orig, to);
					chained = true;
				}
			if (!chained) renamed.set(from, to);
		}
		for (const [from, to] of Object.entries(entry.removed ?? {})) removed.set(from, to);
	}
	return { renamed, removed };
}

/** Where an old state key lands after renames (a workflow rename carries its states). */
export function renamedStateRef(
	renamed: Map<string, string>,
	workflowKey: string,
	stateKey: string
): string {
	const direct = renamed.get(stateRef(workflowKey, stateKey));
	if (direct) return direct;
	const wf = renamed.get(workflowKey);
	return stateRef(wf ?? workflowKey, stateKey);
}

export interface WorkflowWritePlan {
	ids: PackIds;
	/** Statements creating or updating workflows, states and transitions. */
	upserts: CompiledQuery[];
	/** States (and workflows) the new version no longer has, to empty and delete. */
	removedStates: {
		id: string;
		workflow_id: string;
		ref: string;
		name: string;
		workflowName: string;
	}[];
	removedWorkflows: { id: string; key: string; name: string }[];
	/** Statements deleting the removed rows; run after the state mapping moved everything off them. */
	deletes: CompiledQuery[];
}

export function planPackWorkflows(
	db: Kysely<Database>,
	model: PackModel,
	existing: ExistingPackWorkflows,
	ctx: {
		ownerId: string;
		packId: string;
		/** The pack's project: its workflows belong to the project's organization. */
		projectId: string;
		now: number;
		renamed: Map<string, string>;
	}
): WorkflowWritePlan {
	const ids: PackIds = { workflows: new Map(), states: new Map() };
	const upserts: CompiledQuery[] = [];
	const deletes: CompiledQuery[] = [];

	// Match existing workflows and states to the new model by (renamed) key.
	const wfByNewKey = new Map<string, ExistingPackWorkflows['workflows'][number]>();
	for (const w of existing.workflows) wfByNewKey.set(ctx.renamed.get(w.key) ?? w.key, w);
	const stateByNewRef = new Map<string, ExistingPackWorkflows['states'][number]>();
	for (const s of existing.states) {
		const wf = existing.workflows.find((w) => w.id === s.workflow_id);
		if (!wf) continue;
		stateByNewRef.set(renamedStateRef(ctx.renamed, wf.key, s.key), s);
	}

	const keptStates = new Set<string>();
	const keptWorkflows = new Set<string>();
	for (const wf of model.workflows) {
		const prior = wfByNewKey.get(wf.key);
		const wfId = prior?.id ?? newId('wf');
		ids.workflows.set(wf.key, wfId);
		if (prior) keptWorkflows.add(prior.id);
		for (const st of wf.states) {
			const ref = stateRef(wf.key, st.key);
			const priorState = stateByNewRef.get(ref);
			// A state keeps its id only within its own workflow.
			const keep = priorState && priorState.workflow_id === wfId;
			const id = keep ? priorState.id : newId('wfs');
			if (keep) keptStates.add(priorState.id);
			ids.states.set(ref, id);
		}
	}

	for (const wf of model.workflows) {
		const prior = wfByNewKey.get(wf.key);
		const wfId = ids.workflows.get(wf.key)!;
		const initialId = ids.states.get(stateRef(wf.key, wf.initial))!;
		if (prior) {
			upserts.push(
				db
					.updateTable('workflow')
					.set({
						name: wf.name,
						description: wf.description,
						key: wf.key,
						initial_state_id: initialId,
						// The revision trigger allows exactly +1; a transition submitted
						// from a screen read before the replace is refused as stale.
						definition_revision: prior.definition_revision + 1,
						decision_revision: sql`decision_revision + 1`,
						updated_at: ctx.now
					})
					.where('id', '=', wfId)
					.compile()
			);
		} else {
			upserts.push(
				db
					.insertInto('workflow')
					.values({
						id: wfId,
						user_id: ctx.ownerId,
						name: wf.name,
						description: wf.description,
						initial_state_id: initialId,
						pack_id: ctx.packId,
						key: wf.key,
						organization_id: projectOrgExpr(ctx.projectId),
						created_at: ctx.now,
						updated_at: ctx.now
					})
					.compile()
			);
		}
		wf.states.forEach((st, position) => {
			const id = ids.states.get(stateRef(wf.key, st.key))!;
			const values = {
				name: st.name,
				category: st.category,
				position,
				run_scope: storedRunScope(st.run_scope),
				key: st.key
			};
			upserts.push(
				keptStates.has(id)
					? db.updateTable('workflow_state').set(values).where('id', '=', id).compile()
					: db
							.insertInto('workflow_state')
							.values({ id, workflow_id: wfId, ...values, created_at: ctx.now })
							.compile()
			);
		});
	}

	// Transitions are rewritten wholesale; an unchanged action keeps its id.
	const existingTransitionId = new Map(
		existing.transitions.map((t) => [`${t.from_state_id}\0${t.name.toLowerCase()}`, t.id])
	);
	const allWorkflowIds = [...new Set([...existing.workflows.map((w) => w.id)])];
	if (allWorkflowIds.length)
		upserts.push(
			db.deleteFrom('workflow_transition').where('workflow_id', 'in', allWorkflowIds).compile()
		);
	for (const wf of model.workflows) {
		const wfId = ids.workflows.get(wf.key)!;
		for (const st of wf.states) {
			const from = ids.states.get(stateRef(wf.key, st.key))!;
			for (const t of st.transitions) {
				upserts.push(
					db
						.insertInto('workflow_transition')
						.values({
							id: existingTransitionId.get(`${from}\0${t.name.toLowerCase()}`) ?? newId('wft'),
							workflow_id: wfId,
							name: t.name,
							from_state_id: from,
							to_state_id: ids.states.get(stateRef(wf.key, t.to))!,
							requirements: t.requires?.length ? JSON.stringify(t.requires) : null
						})
						.compile()
				);
			}
		}
	}

	const removedStates = existing.states
		.filter((s) => !keptStates.has(s.id))
		.map((s) => {
			const wf = existing.workflows.find((w) => w.id === s.workflow_id)!;
			return {
				id: s.id,
				workflow_id: s.workflow_id,
				ref: stateRef(wf.key, s.key),
				name: s.name,
				workflowName: wf.name
			};
		});
	const removedWorkflows = existing.workflows.filter((w) => !keptWorkflows.has(w.id));
	for (const s of removedStates)
		deletes.push(db.deleteFrom('workflow_state').where('id', '=', s.id).compile());
	for (const w of removedWorkflows)
		deletes.push(db.deleteFrom('workflow').where('id', '=', w.id).compile());
	return { ids, upserts, removedStates, removedWorkflows, deletes };
}
