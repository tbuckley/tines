import {
	canonicalizeLibraryValue,
	parseStrictLibraryJson,
	type AcquireStateRetirementHoldRequest,
	type StateCategory,
	type StateRetirementHold,
	type StateRetirementInventoryV1
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { ApiFail, runAtomic, type ActorContext } from '$lib/server/api/core';
import { newId, type Database } from '$lib/server/db';
import { createStateRetirementInventory } from './inventory';
import { retirementWitnessExpression } from './queries';

type RetirementEnv = Parameters<typeof runAtomic>[0];
type StateRow = {
	id: string;
	workflow_id: string;
	name: string;
	category: StateCategory;
};
type WorkflowRow = { id: string; name: string };
type RunRow = { id: string; state_id_at_start: string; status: string };

function actorKey(actor: ActorContext): string {
	if (actor.viaSession) return `session:${actor.userId}`;
	if (actor.apiKeyId) return `key:${actor.apiKeyId}`;
	throw new ApiFail(403, 'invalid_actor', 'An authenticated session or API key is required');
}

function parseInventory(source: string): StateRetirementInventoryV1 {
	let value: unknown;
	try {
		value = parseStrictLibraryJson(source);
	} catch {
		throw new ApiFail(400, 'invalid_json', 'inventory_json must be strict JSON');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ApiFail(422, 'invalid_inventory', 'inventory_json must contain an inventory object');
	const inventory = value as Record<string, unknown>;
	const keys = [
		'version',
		'owner_id',
		'captured_at',
		'inventory_digest',
		'topology_digest',
		'diagnostics',
		'pointers',
		'witness'
	];
	if (
		Object.keys(inventory).length !== keys.length ||
		!keys.every((key) => Object.hasOwn(inventory, key)) ||
		inventory.version !== 1 ||
		typeof inventory.owner_id !== 'string' ||
		typeof inventory.inventory_digest !== 'string' ||
		typeof inventory.topology_digest !== 'string' ||
		!Array.isArray(inventory.diagnostics) ||
		!Array.isArray(inventory.pointers) ||
		!inventory.witness ||
		typeof inventory.witness !== 'object' ||
		Array.isArray(inventory.witness)
	)
		throw new ApiFail(422, 'invalid_inventory', 'inventory_json has an invalid shape');
	return value as StateRetirementInventoryV1;
}

/** Acquire the durable drain before any preservation plan is prepared. */
export async function acquireStateRetirementHold(
	db: Kysely<Database>,
	env: RetirementEnv,
	actor: ActorContext,
	request: AcquireStateRetirementHoldRequest,
	now = Date.now()
): Promise<StateRetirementHold> {
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage state-retirement holds');
	if (
		!request ||
		typeof request !== 'object' ||
		Object.keys(request).length !== 2 ||
		typeof request.inventory_json !== 'string' ||
		!request.confirmation ||
		typeof request.confirmation !== 'object' ||
		Object.keys(request.confirmation).length !== 1 ||
		typeof request.confirmation.inventory_digest !== 'string'
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected inventory_json and confirmation.inventory_digest'
		);

	const reviewed = parseInventory(request.inventory_json);
	if (reviewed.owner_id !== actor.userId)
		throw new ApiFail(404, 'not_found', 'State retirement inventory not found');
	if (request.confirmation.inventory_digest !== reviewed.inventory_digest)
		throw new ApiFail(409, 'confirmation_mismatch', 'Confirm the exact inventory digest');
	if (reviewed.diagnostics.length)
		throw new ApiFail(
			422,
			'retirement_inventory_blocked',
			'The reviewed inventory has blocking diagnostics',
			{
				diagnostics: reviewed.diagnostics
			}
		);

	const current = await createStateRetirementInventory(db, actor, now);
	if (current.diagnostics.length)
		throw new ApiFail(
			422,
			'retirement_inventory_blocked',
			'The current inventory has blocking diagnostics',
			{ diagnostics: current.diagnostics }
		);
	if (
		current.inventory_digest !== reviewed.inventory_digest ||
		current.topology_digest !== reviewed.topology_digest ||
		canonicalizeLibraryValue(current.witness) !== canonicalizeLibraryValue(reviewed.witness) ||
		canonicalizeLibraryValue(current.pointers) !== canonicalizeLibraryValue(reviewed.pointers)
	)
		throw new ApiFail(
			409,
			'retirement_inventory_stale',
			'The reviewed inventory changed; inventory again'
		);
	if (!current.pointers.length)
		throw new ApiFail(
			422,
			'retirement_no_pointers',
			'There are no state-inheritance pointers to retire'
		);

	const stateIds = [...new Set(current.pointers.flatMap((pointer) => pointer.chain))].sort();
	const states = new Map((current.witness.states as StateRow[]).map((state) => [state.id, state]));
	const workflows = new Map(
		(current.witness.workflows as WorkflowRow[]).map((workflow) => [workflow.id, workflow])
	);
	const heldStates = stateIds.map((stateId) => {
		const state = states.get(stateId);
		const workflow = state && workflows.get(state.workflow_id);
		if (!state || !workflow)
			throw new ApiFail(409, 'retirement_inventory_stale', 'The reviewed topology is incomplete');
		return {
			state_id: state.id,
			workflow_name: workflow.name,
			state_name: state.name,
			state_category: state.category
		};
	});
	const held = new Set(stateIds);
	const activeRuns = (current.witness.active_runs as RunRow[])
		.filter((run) => held.has(run.state_id_at_start))
		.map(({ id, state_id_at_start, status }) => ({ id, state_id_at_start, status }));
	const holdId = newId('srh');
	const key = actorKey(actor);
	const exactWitness = JSON.stringify(reviewed.witness);
	const queries = [
		sql`INSERT INTO state_retirement_hold
			(id,user_id,actor_key,topology_digest,inventory_digest,created_at,released_at)
			SELECT ${holdId},${actor.userId},${key},${current.topology_digest},${current.inventory_digest},${now},NULL
			WHERE ${retirementWitnessExpression(actor.userId)} = ${exactWitness}`.compile(db),
		...heldStates.map((state) =>
			sql`INSERT INTO state_retirement_hold_state
				(hold_id,user_id,state_id,workflow_name,state_name,state_category)
				SELECT ${holdId},${actor.userId},${state.state_id},${state.workflow_name},${state.state_name},${state.state_category}
				WHERE EXISTS (SELECT 1 FROM state_retirement_hold WHERE id = ${holdId} AND user_id = ${actor.userId})`.compile(
				db
			)
		),
		...current.pointers.map((pointer) =>
			sql`INSERT INTO state_retirement_pointer
				(hold_id,user_id,child_state_id,original_parent_state_id,state_witness,successful_receipt_id)
				SELECT ${holdId},${actor.userId},${pointer.child_state_id},${pointer.parent_state_id},${canonicalizeLibraryValue(states.get(pointer.child_state_id))},NULL
				WHERE EXISTS (SELECT 1 FROM state_retirement_hold WHERE id = ${holdId} AND user_id = ${actor.userId})`.compile(
				db
			)
		)
	];
	try {
		const results = await runAtomic(env, queries);
		if (results[0]?.meta.changes !== 1)
			throw new ApiFail(
				409,
				'retirement_inventory_stale',
				'The reviewed inventory changed while the hold was acquired; inventory again'
			);
	} catch (error) {
		if (String(error).includes('state_retirement_state_already_held'))
			throw new ApiFail(
				409,
				'retirement_state_already_held',
				'An affected state already has an active hold'
			);
		throw error;
	}
	return {
		id: holdId,
		inventory_digest: current.inventory_digest,
		topology_digest: current.topology_digest,
		created_at: now,
		held_states: heldStates,
		active_runs: activeRuns
	};
}
