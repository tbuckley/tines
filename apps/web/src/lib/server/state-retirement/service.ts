import {
	canonicalizeLibraryValue,
	parseStrictLibraryJson,
	type ApplyStateRetirementRequest,
	type AcquireStateRetirementHoldRequest,
	type StateCategory,
	type StateRetirementHold,
	type StateRetirementInventoryV1,
	type StateRetirementPlanResponse,
	type StateRetirementReceiptV1,
	type StateRetirementPlanV1
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { ApiFail, runAtomic, type ActorContext } from '$lib/server/api/core';
import { newId, type Database } from '$lib/server/db';
import { createStateRetirementInventory } from './inventory';
import { planStateRetirement } from './preserve';
import {
	compileRetirementQueries,
	retirementWitnessExpression,
	validateRetirementBatch
} from './queries';
import {
	RETIREMENT_COMPILER_VERSION,
	RETIREMENT_PLAN_TTL_MS,
	retirementActorKey,
	retirementKeyMaterial,
	signRetirementPlan,
	tokenPayloadForPlan,
	verifyRetirementPlan,
	type RetirementPlanTokenPayload
} from './token';
import { sha256Hex } from '$lib/server/crypto';

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

export function parseInventory(source: string): StateRetirementInventoryV1 {
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

function requireOperator(actor: ActorContext) {
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage state-retirement plans');
}

function parseReceipt(row: { receipt_json: string }): StateRetirementReceiptV1 {
	try {
		const receipt = parseStrictLibraryJson(row.receipt_json) as StateRetirementReceiptV1;
		if (
			!receipt ||
			typeof receipt !== 'object' ||
			receipt.version !== 1 ||
			typeof receipt.id !== 'string'
		)
			throw new Error('shape');
		return receipt;
	} catch {
		throw new ApiFail(500, 'invalid_receipt', 'The durable state-retirement receipt is invalid');
	}
}

async function digestPlan(plan: StateRetirementPlanV1): Promise<string> {
	return `sha256:${await sha256Hex(canonicalizeLibraryValue(plan))}`;
}

async function requestDigest(
	payload: RetirementPlanTokenPayload,
	inventoryJson: string,
	confirmationDigest = payload.plan_digest
): Promise<string> {
	return sha256Hex(
		canonicalizeLibraryValue({
			payload,
			inventory_json: inventoryJson,
			confirmation: { plan_digest: confirmationDigest }
		})
	);
}

function assertPlanAllocations(plan: StateRetirementPlanV1, token: RetirementPlanTokenPayload) {
	if (canonicalizeLibraryValue(plan.allocations) !== canonicalizeLibraryValue(token.allocations))
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The signed allocation no longer matches this inventory; prepare again'
		);
}

function planResponse(
	plan: StateRetirementPlanV1,
	payload: RetirementPlanTokenPayload,
	budget: StateRetirementPlanResponse['budget'],
	inventoryJson: string,
	token?: string
): StateRetirementPlanResponse {
	return {
		version: 1,
		plan_id: payload.id,
		plan_digest: payload.plan_digest,
		inventory_digest: payload.inventory_digest,
		issued_at: payload.issued_at,
		expires_at: payload.expires_at,
		compiler_version: payload.compiler_version,
		actor_key: payload.actor_key,
		budget,
		plan,
		inventory_json: inventoryJson,
		...(token ? { plan_token: token } : {})
	};
}

export async function prepareStateRetirement(
	db: Kysely<Database>,
	env: Pick<Env, 'SECRET_ENCRYPTION_KEY' | 'BETTER_AUTH_SECRET'>,
	actor: ActorContext,
	request: unknown,
	now = Date.now()
): Promise<StateRetirementPlanResponse> {
	requireOperator(actor);
	if (!request || typeof request !== 'object' || Array.isArray(request))
		throw new ApiFail(422, 'invalid_field', 'Expected hold_id and optional inventory_json');
	const raw = request as Record<string, unknown>;
	if (
		Object.keys(raw).some((key) => !['hold_id', 'inventory_json'].includes(key)) ||
		typeof raw.hold_id !== 'string' ||
		(raw.inventory_json !== undefined && typeof raw.inventory_json !== 'string')
	)
		throw new ApiFail(422, 'invalid_field', 'Expected hold_id and optional inventory_json');
	const input = request as { hold_id: string; inventory_json?: string };
	const hold = await db
		.selectFrom('state_retirement_hold')
		.selectAll()
		.where('id', '=', input.hold_id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!hold) throw new ApiFail(404, 'not_found', 'State-retirement hold not found');
	if (hold.released_at !== null)
		throw new ApiFail(
			409,
			'retirement_hold_changed',
			'The state-retirement hold is released; acquire a new hold'
		);
	const reviewed = input.inventory_json ? parseInventory(input.inventory_json) : null;
	if (
		reviewed &&
		(reviewed.owner_id !== actor.userId || reviewed.inventory_digest !== hold.inventory_digest)
	)
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The reviewed inventory does not match this hold; inventory again'
		);
	const current = await createStateRetirementInventory(db, actor, now);
	if (reviewed && current.topology_digest !== reviewed.topology_digest)
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The inventory changed after the drain; inventory and hold again'
		);
	const effective = current;
	const heldStateIds = new Set(
		(
			await db
				.selectFrom('state_retirement_hold_state')
				.select('state_id')
				.where('hold_id', '=', input.hold_id)
				.where('user_id', '=', actor.userId)
				.execute()
		).map((row) => row.state_id)
	);
	const activeRuns = effective.witness.active_runs.filter((run) =>
		heldStateIds.has(String(run.state_id_at_start))
	);
	if (activeRuns.length > 0)
		throw new ApiFail(
			409,
			'retirement_active_runs',
			'Affected runs are still active; drain them before preparing',
			{
				active_run_ids: activeRuns.map((run) => String(run.id))
			}
		);
	const plan = planStateRetirement(effective);
	const payloadBase = {
		version: 1 as const,
		compiler_version: RETIREMENT_COMPILER_VERSION,
		id: newId('srp'),
		hold_id: input.hold_id,
		user_id: actor.userId,
		actor_key: retirementActorKey(actor),
		issued_at: now,
		expires_at: now + RETIREMENT_PLAN_TTL_MS,
		inventory_digest: effective.inventory_digest,
		topology_digest: effective.topology_digest,
		held_states: plan.held_states
	};
	const plan_digest = await digestPlan(plan);
	const payload = tokenPayloadForPlan(plan, payloadBase, plan_digest);
	const receipt: StateRetirementReceiptV1 = {
		version: 1,
		id: payload.id,
		plan_id: payload.id,
		hold_id: payload.hold_id,
		owner_id: actor.userId,
		actor_key: payload.actor_key,
		inventory_digest: payload.inventory_digest,
		plan_digest,
		request_digest: '',
		execution_nonce: newId('exe'),
		committed_at: now,
		cleared_pointers: plan.rollback.original_pointers.map(
			({ child_state_id, parent_state_id }) => ({ child_state_id, parent_state_id })
		),
		copies: plan.allocations.map(
			({ source_item_id, copy_item_id, copy_file_ids, name, scope }) => ({
				source_item_id,
				copy_item_id,
				copy_file_ids,
				name,
				scope
			})
		),
		source_inventory_digest: effective.inventory_digest
	};
	const effectiveInventoryJson = JSON.stringify(effective);
	receipt.request_digest = await requestDigest(payload, effectiveInventoryJson);
	let budget: StateRetirementPlanResponse['budget'];
	try {
		budget = validateRetirementBatch(
			compileRetirementQueries(
				db,
				actor,
				payload,
				effective,
				plan,
				receipt.request_digest,
				receipt.execution_nonce,
				receipt
			)
		);
	} catch (error) {
		throw new ApiFail(
			422,
			'retirement_plan_too_large',
			error instanceof Error ? error.message : 'The preservation batch exceeds its limits'
		);
	}
	if (!plan.applyable) return planResponse(plan, payload, budget, effectiveInventoryJson);
	const token = await signRetirementPlan(payload, retirementKeyMaterial(env));
	return planResponse(plan, payload, budget, effectiveInventoryJson, token);
}

export async function applyStateRetirement(
	db: Kysely<Database>,
	env: Pick<Env, 'SECRET_ENCRYPTION_KEY' | 'BETTER_AUTH_SECRET'>,
	actor: ActorContext,
	request: ApplyStateRetirementRequest,
	now = Date.now()
): Promise<StateRetirementReceiptV1> {
	requireOperator(actor);
	if (
		!request ||
		typeof request !== 'object' ||
		Object.keys(request).length !== 3 ||
		typeof request.plan_token !== 'string' ||
		typeof request.inventory_json !== 'string' ||
		!request.confirmation ||
		Object.keys(request.confirmation).length !== 1 ||
		typeof request.confirmation.plan_digest !== 'string'
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected plan_token, inventory_json, and confirmation.plan_digest'
		);
	const payload = await verifyRetirementPlan(request.plan_token, retirementKeyMaterial(env));
	if (payload.user_id !== actor.userId || payload.actor_key !== retirementActorKey(actor))
		throw new ApiFail(404, 'not_found', 'State-retirement plan not found');
	const reviewed = parseInventory(request.inventory_json);
	const digest = await requestDigest(
		payload,
		request.inventory_json,
		request.confirmation.plan_digest
	);
	const prior = await db
		.selectFrom('state_retirement_receipt')
		.select(['receipt_json'])
		.where('user_id', '=', actor.userId)
		.where('request_digest', '=', digest)
		.executeTakeFirst();
	if (prior) return parseReceipt(prior);
	if (request.confirmation.plan_digest !== payload.plan_digest)
		throw new ApiFail(409, 'confirmation_mismatch', 'Confirm the exact signed plan digest');
	if (reviewed.owner_id !== actor.userId || reviewed.inventory_digest !== payload.inventory_digest)
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The inventory does not match the signed plan; retry with the unchanged plan'
		);
	if (payload.expires_at <= now)
		throw new ApiFail(409, 'retirement_plan_expired', 'The signed plan expired; prepare again');
	if (payload.compiler_version !== RETIREMENT_COMPILER_VERSION)
		throw new ApiFail(409, 'retirement_plan_stale', 'The compiler changed; prepare again');
	const current = await createStateRetirementInventory(db, actor, now);
	if (
		current.inventory_digest !== reviewed.inventory_digest ||
		current.topology_digest !== reviewed.topology_digest
	)
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The live witness changed; retry with the unchanged plan'
		);
	const plan = planStateRetirement(reviewed);
	if (!plan.applyable)
		throw new ApiFail(422, 'retirement_plan_blocked', 'The signed plan is no longer applyable', {
			diagnostics: plan.diagnostics
		});
	if ((await digestPlan(plan)) !== payload.plan_digest)
		throw new ApiFail(409, 'retirement_plan_stale', 'The preservation plan changed; prepare again');
	assertPlanAllocations(plan, payload);
	const receipt: StateRetirementReceiptV1 = {
		version: 1,
		id: payload.id,
		plan_id: payload.id,
		hold_id: payload.hold_id,
		owner_id: actor.userId,
		actor_key: payload.actor_key,
		inventory_digest: payload.inventory_digest,
		plan_digest: payload.plan_digest,
		request_digest: digest,
		execution_nonce: newId('exe'),
		committed_at: now,
		cleared_pointers: plan.rollback.original_pointers.map(
			({ child_state_id, parent_state_id }) => ({ child_state_id, parent_state_id })
		),
		copies: plan.allocations.map(
			({ source_item_id, copy_item_id, copy_file_ids, name, scope }) => ({
				source_item_id,
				copy_item_id,
				copy_file_ids,
				name,
				scope
			})
		),
		source_inventory_digest: reviewed.inventory_digest
	};
	let results;
	try {
		const queries = compileRetirementQueries(
			db,
			actor,
			payload,
			reviewed,
			plan,
			digest,
			receipt.execution_nonce,
			receipt
		);
		validateRetirementBatch(queries);
		results = await runAtomic(env as Env, queries);
	} catch (error) {
		const recovered = await db
			.selectFrom('state_retirement_receipt')
			.select(['receipt_json'])
			.where('user_id', '=', actor.userId)
			.where('request_digest', '=', digest)
			.executeTakeFirst();
		if (recovered) return parseReceipt(recovered);
		throw error;
	}
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new ApiFail(
			409,
			'retirement_plan_stale',
			'The live witness, hold, run, pointer, or destination guard failed; no writes were made'
		);
	const committed = results.at(-1)?.results?.[0] as { receipt_json?: string } | undefined;
	if (!committed?.receipt_json)
		throw new ApiFail(
			503,
			'retirement_outcome_unknown',
			'The apply outcome is unknown; retry the same unchanged plan to recover its receipt'
		);
	return parseReceipt(committed as { receipt_json: string });
}

export async function getStateRetirementReceipt(
	db: Kysely<Database>,
	actor: ActorContext,
	id: string
): Promise<StateRetirementReceiptV1> {
	requireOperator(actor);
	const row = await db
		.selectFrom('state_retirement_receipt')
		.select(['receipt_json'])
		.where('id', '=', id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!row) throw new ApiFail(404, 'not_found', 'State-retirement receipt not found');
	return parseReceipt(row);
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
