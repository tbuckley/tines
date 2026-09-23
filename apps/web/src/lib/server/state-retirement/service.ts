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
	type StateRetirementPlanV1,
	type StateRetirementVerification,
	type ReleaseStateRetirementHoldRequest,
	type StateRetirementRollbackPrepareResponse,
	type StateRetirementRollbackApplyRequest
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
	signRetirementRollback,
	tokenPayloadForPlan,
	verifyRetirementPlan,
	verifyRetirementRollback,
	type RetirementPlanTokenPayload,
	type RetirementRollbackTokenPayload
} from './token';
import { sha256Hex } from '$lib/server/crypto';
import { effectiveContextForTarget, issueMatchTarget } from '$lib/server/api/context';

type RetirementEnv = Parameters<typeof runAtomic>[0];
type StateRetirementServiceEnv = Pick<
	Env,
	'SECRET_ENCRYPTION_KEY' | 'BETTER_AUTH_SECRET' | 'STATE_RETIREMENT_RELEASE'
>;
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

/** Release B keeps inspection and release, but retires new A operations. */
function retiredOperation(
	operation: string,
	env: Pick<StateRetirementServiceEnv, 'STATE_RETIREMENT_RELEASE'>
): void {
	if (import.meta.env.MODE === 'test' && env?.STATE_RETIREMENT_RELEASE === 'A') return;
	throw new ApiFail(
		410,
		'state_retirement_operation_retired',
		`State-retirement ${operation} is retired; use the existing receipt verification or release operation`,
		{ operation, retired: true }
	);
}

type GuardItem = StateRetirementReceiptV1['rollback_guard']['items'][number];
type GuardFile = StateRetirementReceiptV1['rollback_guard']['files'][number];

async function digestGuard(value: unknown): Promise<string> {
	return `sha256:${await sha256Hex(canonicalizeLibraryValue(value))}`;
}

function guardItemValue(row: Record<string, unknown>) {
	return {
		id: String(row.id),
		kind: row.kind ?? null,
		name: row.name ?? null,
		description: row.description ?? null,
		project_id: row.project_id ?? null,
		workflow_state_id: row.workflow_state_id ?? null,
		label_id: row.label_id ?? null,
		issue_id: row.issue_id ?? null,
		body: row.body ?? null,
		repo_url: row.repo_url ?? null,
		repo_branch: row.repo_branch ?? null,
		repo_dir: row.repo_dir ?? null,
		config: row.config ?? null,
		env_hint: row.env_hint ?? null,
		env_secret: row.env_secret === true || row.env_secret === 1,
		position: row.position ?? null,
		version: row.version ?? null,
		updated_at: row.updated_at ?? null
	};
}

async function rollbackGuard(
	inventory: StateRetirementInventoryV1,
	plan: StateRetirementPlanV1,
	committedAt: number
): Promise<StateRetirementReceiptV1['rollback_guard']> {
	const items: GuardItem[] = [];
	for (const row of inventory.witness.context_items) {
		const value = guardItemValue(row);
		items.push({
			id: value.id,
			version: Number(value.version ?? 0),
			updated_at: Number(value.updated_at ?? 0),
			scope: {
				project_id: (value.project_id as string | null) ?? null,
				workflow_state_id: (value.workflow_state_id as string | null) ?? null,
				label_id: (value.label_id as string | null) ?? null,
				issue_id: (value.issue_id as string | null) ?? null
			},
			payload_digest: await digestGuard(value)
		});
	}
	const files: GuardFile[] = [];
	for (const row of inventory.witness.context_files) {
		files.push({
			id: String(row.id),
			context_item_id: String(row.context_item_id),
			updated_at: Number(row.updated_at ?? 0),
			content_digest: await digestGuard({ path: row.path, content: row.content })
		});
	}
	for (const operation of plan.proposed_operations) {
		if (operation.kind !== 'copy_context_item') continue;
		const value = guardItemValue({
			...operation.payload.item,
			id: operation.allocation.copy_item_id,
			name: operation.allocation.name,
			project_id: operation.allocation.scope.project_id,
			workflow_state_id: operation.allocation.scope.workflow_state_id,
			label_id: operation.allocation.scope.label_id,
			issue_id: operation.allocation.scope.issue_id,
			position: operation.allocation.position,
			version: 1,
			updated_at: committedAt
		});
		items.push({
			id: value.id,
			version: 1,
			updated_at: committedAt,
			scope: {
				project_id: value.project_id as string | null,
				workflow_state_id: value.workflow_state_id as string | null,
				label_id: value.label_id as string | null,
				issue_id: value.issue_id as string | null
			},
			payload_digest: await digestGuard(value)
		});
		for (const file of operation.payload.files)
			files.push({
				id: file.id,
				context_item_id: value.id,
				updated_at: committedAt,
				content_digest: await digestGuard({ path: file.path, content: file.content })
			});
	}
	return { items, files };
}

function effectiveBundle(
	value: Awaited<ReturnType<typeof effectiveContextForTarget>>
): StateRetirementReceiptV1['verification'][number]['after'] {
	const scope = (row: {
		project_id?: string | null;
		workflow_state_id?: string | null;
		label_id?: string | null;
		issue_id?: string | null;
	}) => ({
		project_id: row.project_id ?? null,
		workflow_state_id: row.workflow_state_id ?? null,
		label_id: row.label_id ?? null,
		issue_id: row.issue_id ?? null
	});
	const item = (row: any) => ({
		item_id: row.item_id,
		kind: row.kind ?? 'prompt',
		name: row.name,
		scope: scope(row.scope),
		...(row.body !== undefined ? { body: row.body } : {}),
		...(row.files !== undefined ? { files: row.files } : {}),
		...(row.url !== undefined ? { repo: { url: row.url, branch: row.branch, dir: row.dir } } : {}),
		...(row.secret !== undefined ? { env: { secret: row.secret, hint: row.hint ?? null } } : {}),
		position: row.position ?? 0,
		version: row.version,
		inherited_from: row.inherited_from ?? null,
		is_journal: row.is_journal === true
	});
	return {
		prompts: value.prompt.parts.map((p) => item({ ...p, kind: 'prompt', scope: p.scope })),
		skills: value.skills.map((p) => item({ ...p, kind: 'skill', scope: p.scope })),
		repos: value.repos.map((p) => item({ ...p, kind: 'repo', scope: p.scope })),
		envs: value.env.map((p) => item({ ...p, kind: 'env', scope: p.scope })),
		overridden: value.overridden.map((p) => ({
			item_id: p.item_id,
			overridden_by: p.overridden_by,
			kind: p.kind,
			name: p.name
		})),
		repo_conflicts: value.conflicts.map((p) => ({ dir: p.dir, item_ids: p.item_ids })),
		journal: {
			state_id: value.prompt.journal.state_id,
			item_id: value.prompt.journal.item_id,
			version: value.prompt.journal.version
		}
	};
}

function sameValue(a: unknown, b: unknown): boolean {
	return canonicalizeLibraryValue(a) === canonicalizeLibraryValue(b);
}

async function receiptForPlan(
	plan: StateRetirementPlanV1,
	inventory: StateRetirementInventoryV1,
	base: Omit<StateRetirementReceiptV1, 'verification' | 'rollback_guard'>
): Promise<StateRetirementReceiptV1> {
	return {
		...base,
		verification: plan.comparisons.map((comparison) => ({
			target: comparison.target,
			after: comparison.after,
			launch_after_text: comparison.launch.after_text,
			journal: comparison.after.journal
		})),
		rollback_guard: await rollbackGuard(inventory, plan, base.committed_at)
	};
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
	env: StateRetirementServiceEnv,
	actor: ActorContext,
	request: unknown,
	now = Date.now()
): Promise<StateRetirementPlanResponse> {
	retiredOperation('prepare', env);
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
	const receipt = await receiptForPlan(plan, effective, {
		version: 1,
		id: payload.id,
		plan_id: payload.id,
		hold_id: payload.hold_id,
		kind: 'preserve',
		rollback_of_receipt_id: null,
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
	});
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
	env: StateRetirementServiceEnv,
	actor: ActorContext,
	request: ApplyStateRetirementRequest,
	now = Date.now()
): Promise<StateRetirementReceiptV1> {
	retiredOperation('apply', env);
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
	const receipt = await receiptForPlan(plan, reviewed, {
		version: 1,
		id: payload.id,
		plan_id: payload.id,
		hold_id: payload.hold_id,
		kind: 'preserve',
		rollback_of_receipt_id: null,
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
	});
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

async function ownedReceipt(db: Kysely<Database>, actor: ActorContext, id: string) {
	const row = await db
		.selectFrom('state_retirement_receipt')
		.selectAll()
		.where('id', '=', id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!row) throw new ApiFail(404, 'not_found', 'State-retirement receipt not found');
	return { row, receipt: parseReceipt(row) };
}

export async function verifyStateRetirementReceipt(
	db: Kysely<Database>,
	actor: ActorContext,
	id: string
): Promise<StateRetirementVerification> {
	requireOperator(actor);
	const { receipt } = await ownedReceipt(db, actor, id);
	const entries: StateRetirementVerification['entries'] = [];
	let mismatch = false;
	for (const expected of receipt.verification ?? []) {
		if (expected.target.issue.kind !== 'explicit') {
			entries.push({
				target: expected.target,
				mode: 'stage-preview',
				expected: expected.after,
				current: null,
				journal: { expected: expected.journal, current: null },
				differences: ['stage preview: no production issue was created'],
				issue_launch_preview: null
			});
			continue;
		}
		const issueId = expected.target.issue.id;
		try {
			const target = await issueMatchTarget(db, actor.userId, issueId);
			const currentContext = await effectiveContextForTarget(db, actor.userId, target);
			const current = effectiveBundle(currentContext);
			const differences: string[] = [];
			if (!sameValue(current, expected.after))
				differences.push('effective context differs from the stored projected-after bundle');
			if (!sameValue(current.journal, expected.journal))
				differences.push('local journal target or version differs');
			if (differences.length) mismatch = true;
			entries.push({
				target: expected.target,
				mode: 'exact-issue',
				expected: expected.after,
				current,
				journal: { expected: expected.journal, current: current.journal },
				differences,
				issue_launch_preview: currentContext.prompt.text
			});
		} catch {
			mismatch = true;
			entries.push({
				target: expected.target,
				mode: 'exact-issue',
				expected: expected.after,
				current: null,
				journal: { expected: expected.journal, current: null },
				differences: ['explicit issue target no longer exists'],
				issue_launch_preview: null
			});
		}
	}
	return {
		receipt_id: receipt.id,
		status: entries.some((entry) => entry.mode === 'stage-preview')
			? 'preview'
			: mismatch
				? 'mismatch'
				: 'verified',
		entries
	};
}

export async function releaseStateRetirementHold(
	db: Kysely<Database>,
	env: RetirementEnv,
	actor: ActorContext,
	holdId: string,
	request: ReleaseStateRetirementHoldRequest,
	now = Date.now()
) {
	requireOperator(actor);
	if (
		!request ||
		Object.keys(request).length !== 1 ||
		!request.confirmation ||
		Object.keys(request.confirmation).length !== 2 ||
		request.confirmation.hold_id !== holdId ||
		request.confirmation.release !== true
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Explicit owner confirmation is required to release this hold'
		);
	const hold = await db
		.selectFrom('state_retirement_hold')
		.selectAll()
		.where('id', '=', holdId)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!hold) throw new ApiFail(404, 'not_found', 'State-retirement hold not found');
	const pointers = await db
		.selectFrom('state_retirement_pointer')
		.selectAll()
		.where('hold_id', '=', holdId)
		.where('user_id', '=', actor.userId)
		.execute();
	if (hold.released_at !== null)
		return {
			hold_id: holdId,
			status: pointers.some((p) => p.successful_receipt_id === null)
				? 'released_abandoned'
				: 'released_verified',
			released_at: hold.released_at
		};
	const unresolved = await db
		.selectFrom('workflow_state')
		.select('id')
		.where(
			'id',
			'in',
			pointers.map((p) => p.child_state_id)
		)
		.where('inherits_from_state_id', 'is not', null)
		.execute();
	const successful = pointers
		.map((p) => p.successful_receipt_id)
		.filter((id): id is string => !!id);
	const rollbackExists = await db
		.selectFrom('state_retirement_receipt')
		.select('id')
		.where('hold_id', '=', holdId)
		.where('user_id', '=', actor.userId)
		.where('kind', '=', 'rollback')
		.executeTakeFirst();
	if (rollbackExists && unresolved.length > 0)
		throw new ApiFail(
			409,
			'retirement_unresolved',
			'Rollback restored a pointer; preserve again before releasing the hold'
		);
	for (const receiptId of [...new Set(successful)]) {
		const verification = await verifyStateRetirementReceipt(db, actor, receiptId);
		if (verification.status === 'mismatch')
			throw new ApiFail(
				409,
				'retirement_verification_required',
				'Current exact-state context differs; keep dispatch drained'
			);
	}
	if (successful.length > 0 && unresolved.length > 0)
		throw new ApiFail(
			409,
			'retirement_unresolved',
			'Preservation is not verified; keep dispatch drained and re-prepare'
		);
	const result = await db
		.updateTable('state_retirement_hold')
		.set({ released_at: now })
		.where('id', '=', holdId)
		.where('user_id', '=', actor.userId)
		.where('released_at', 'is', null)
		.executeTakeFirst();
	return {
		hold_id: holdId,
		status: successful.length ? 'released_verified' : 'released_abandoned',
		released_at: result.numUpdatedRows ? now : hold.released_at
	};
}

export async function prepareStateRetirementRollback(
	db: Kysely<Database>,
	env: StateRetirementServiceEnv,
	actor: ActorContext,
	receiptId: string,
	now = Date.now()
): Promise<StateRetirementRollbackPrepareResponse> {
	retiredOperation('rollback preparation', env);
	requireOperator(actor);
	const { receipt } = await ownedReceipt(db, actor, receiptId);
	if (receipt.kind !== 'preserve')
		throw new ApiFail(
			409,
			'retirement_rollback_invalid',
			'Only a preservation receipt can be reversed'
		);
	const hold = await db
		.selectFrom('state_retirement_hold')
		.selectAll()
		.where('id', '=', receipt.hold_id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!hold || hold.released_at !== null)
		throw new ApiFail(409, 'retirement_hold_changed', 'The receipt hold is not active');
	const expires_at = now + RETIREMENT_PLAN_TTL_MS;
	const payload: RetirementRollbackTokenPayload = {
		version: 1,
		receipt_id: receiptId,
		hold_id: receipt.hold_id,
		user_id: actor.userId,
		actor_key: retirementActorKey(actor),
		issued_at: now,
		expires_at
	};
	return {
		version: 1,
		receipt_id: receiptId,
		hold_id: receipt.hold_id,
		expires_at,
		rollback_token: await signRetirementRollback(payload, retirementKeyMaterial(env))
	};
}

export async function applyStateRetirementRollback(
	db: Kysely<Database>,
	env: StateRetirementServiceEnv,
	actor: ActorContext,
	request: StateRetirementRollbackApplyRequest,
	now = Date.now()
): Promise<StateRetirementReceiptV1> {
	retiredOperation('rollback apply', env);
	requireOperator(actor);
	if (
		!request ||
		Object.keys(request).length !== 2 ||
		typeof request.rollback_token !== 'string' ||
		!request.confirmation ||
		Object.keys(request.confirmation).length !== 2
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected rollback_token and confirmation.receipt_id/hold_id'
		);
	const payload = await verifyRetirementRollback(
		request.rollback_token,
		retirementKeyMaterial(env)
	);
	if (
		payload.user_id !== actor.userId ||
		payload.actor_key !== retirementActorKey(actor) ||
		request.confirmation.receipt_id !== payload.receipt_id ||
		request.confirmation.hold_id !== payload.hold_id
	)
		throw new ApiFail(404, 'not_found', 'Rollback authorization not found');
	if (payload.expires_at <= now)
		throw new ApiFail(
			409,
			'retirement_plan_expired',
			'The rollback authorization expired; prepare again'
		);
	const { receipt: original } = await ownedReceipt(db, actor, payload.receipt_id);
	if (original.kind !== 'preserve')
		throw new ApiFail(
			409,
			'retirement_rollback_invalid',
			'Only a preservation receipt can be reversed'
		);
	const requestDigest = await sha256Hex(
		canonicalizeLibraryValue({ payload, confirmation: request.confirmation })
	);
	const prior = await db
		.selectFrom('state_retirement_receipt')
		.select('receipt_json')
		.where('user_id', '=', actor.userId)
		.where('request_digest', '=', requestDigest)
		.executeTakeFirst();
	if (prior) return parseReceipt(prior);
	const rollbackId = newId('srr');
	const rollbackReceipt: StateRetirementReceiptV1 = {
		...original,
		id: rollbackId,
		kind: 'rollback',
		rollback_of_receipt_id: original.id,
		request_digest: requestDigest,
		execution_nonce: newId('exe'),
		committed_at: now
	};
	const guards = original.rollback_guard?.items ?? [];
	const expectedIds = guards.map((g) => g.id);
	const currentItems = await db
		.selectFrom('context_item')
		.selectAll()
		.where('user_id', '=', actor.userId)
		.where('kind', '!=', 'artifact')
		.execute();
	const currentFiles = await db
		.selectFrom('context_item_file')
		.selectAll()
		.where(
			'context_item_id',
			'in',
			currentItems.map((i) => i.id)
		)
		.execute();
	if (
		currentItems.length !== expectedIds.length ||
		currentItems.some((row) => !expectedIds.includes(row.id))
	)
		throw new ApiFail(
			409,
			'retirement_rollback_refused',
			'A new context reference or payload exists; nothing was reversed'
		);
	for (const guard of guards) {
		const row = currentItems.find((item) => item.id === guard.id)!;
		if (
			row.version !== guard.version ||
			row.updated_at !== guard.updated_at ||
			(await digestGuard(guardItemValue({ ...row, env_secret: row.env_value_enc !== null }))) !==
				guard.payload_digest
		)
			throw new ApiFail(
				409,
				'retirement_rollback_refused',
				'A source, local, or generated payload changed; nothing was reversed'
			);
	}
	const guardFiles = original.rollback_guard?.files ?? [];
	if (
		currentFiles.length !== guardFiles.length ||
		currentFiles.some(
			(file) => !guardFiles.some((g) => g.id === file.id && g.updated_at === file.updated_at)
		)
	)
		throw new ApiFail(
			409,
			'retirement_rollback_refused',
			'A file payload changed or a new reference was added; nothing was reversed'
		);
	for (const file of currentFiles) {
		const guard = guardFiles.find((candidate) => candidate.id === file.id)!;
		if ((await digestGuard({ path: file.path, content: file.content })) !== guard.content_digest)
			throw new ApiFail(
				409,
				'retirement_rollback_refused',
				'A file payload changed; nothing was reversed'
			);
	}
	const hold = await db
		.selectFrom('state_retirement_hold')
		.selectAll()
		.where('id', '=', payload.hold_id)
		.where('user_id', '=', actor.userId)
		.executeTakeFirst();
	if (!hold || hold.released_at !== null)
		throw new ApiFail(409, 'retirement_hold_changed', 'The receipt hold is not active');
	const activeRuns = await db
		.selectFrom('agent_run')
		.select('id')
		.where('user_id', '=', actor.userId)
		.where('status', 'in', ['assigned', 'launching', 'running'])
		.where(
			'state_id_at_start',
			'in',
			original.cleared_pointers.flatMap((p) => [p.child_state_id, p.parent_state_id])
		)
		.execute();
	if (activeRuns.length)
		throw new ApiFail(
			409,
			'retirement_active_runs',
			'Affected runs are still active; rollback remains held'
		);
	const pointerGuards = original.cleared_pointers.map(
		(p) =>
			sql<boolean>`EXISTS (SELECT 1 FROM workflow_state WHERE id=${p.child_state_id} AND inherits_from_state_id IS NULL)`
	);
	const contextGuards = guards.map(
		(guard) =>
			sql<boolean>`EXISTS (SELECT 1 FROM context_item c WHERE c.user_id=${actor.userId} AND c.id=${guard.id} AND c.version=${guard.version} AND c.updated_at=${guard.updated_at} AND c.project_id IS ${guard.scope.project_id === null ? sql`NULL` : sql`${guard.scope.project_id}`} AND c.workflow_state_id IS ${guard.scope.workflow_state_id === null ? sql`NULL` : sql`${guard.scope.workflow_state_id}`} AND c.label_id IS ${guard.scope.label_id === null ? sql`NULL` : sql`${guard.scope.label_id}`} AND c.issue_id IS ${guard.scope.issue_id === null ? sql`NULL` : sql`${guard.scope.issue_id}`})`
	);
	const fileGuards = (original.rollback_guard?.files ?? []).map(
		(file) =>
			sql<boolean>`EXISTS (SELECT 1 FROM context_item_file WHERE id=${file.id} AND context_item_id=${file.context_item_id} AND updated_at=${file.updated_at})`
	);
	const receiptGate = sql<boolean>`EXISTS (SELECT 1 FROM state_retirement_receipt WHERE id=${rollbackId} AND user_id=${actor.userId} AND kind='rollback')`;
	const guardSql = [
		...contextGuards,
		...fileGuards,
		sql<boolean>`(SELECT COUNT(*) FROM context_item WHERE user_id=${actor.userId} AND kind != 'artifact')=${guards.length}`
	];
	const queries = [
		sql`INSERT INTO state_retirement_receipt (id,user_id,hold_id,actor_key,kind,rollback_of_receipt_id,inventory_digest,plan_digest,request_digest,execution_nonce,receipt_json,committed_at) SELECT ${rollbackId},${actor.userId},${payload.hold_id},${payload.actor_key},'rollback',${original.id},${original.inventory_digest},${original.plan_digest},${requestDigest},${rollbackReceipt.execution_nonce},${JSON.stringify(rollbackReceipt)},${now} WHERE EXISTS (SELECT 1 FROM state_retirement_hold WHERE id=${payload.hold_id} AND user_id=${actor.userId} AND released_at IS NULL) AND ${sql.join([...pointerGuards, ...guardSql], sql` AND `)}`.compile(
			db
		)
	];
	for (const p of original.cleared_pointers)
		queries.push(
			sql`INSERT INTO state_retirement_restore_authorization (receipt_id,user_id,hold_id,child_state_id,parent_state_id,consumed_at) SELECT ${rollbackId},${actor.userId},${payload.hold_id},${p.child_state_id},${p.parent_state_id},NULL WHERE ${receiptGate}`.compile(
				db
			)
		);
	for (const p of original.cleared_pointers)
		queries.push(
			sql`UPDATE workflow_state SET inherits_from_state_id=${p.parent_state_id} WHERE id=${p.child_state_id} AND inherits_from_state_id IS NULL AND ${receiptGate}`.compile(
				db
			)
		);
	for (const copy of original.copies) {
		queries.push(
			sql`DELETE FROM context_item_file WHERE context_item_id=${copy.copy_item_id} AND ${receiptGate}`.compile(
				db
			)
		);
		queries.push(
			sql`DELETE FROM context_item WHERE id=${copy.copy_item_id} AND user_id=${actor.userId} AND ${receiptGate}`.compile(
				db
			)
		);
		queries.push(
			sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,issue_id,project_id,payload,created_at)
			SELECT ${`evt_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`},${actor.userId},'context.deleted',${actor.userId},${actor.apiKeyId},${copy.scope.issue_id},${copy.scope.project_id},${JSON.stringify({ context_id: copy.copy_item_id, retirement_receipt_id: rollbackId, rollback_of_receipt_id: original.id })},${now} WHERE ${receiptGate}`.compile(
				db
			)
		);
	}
	queries.push(
		sql`UPDATE state_retirement_pointer SET successful_receipt_id=NULL WHERE hold_id=${payload.hold_id} AND user_id=${actor.userId} AND ${receiptGate}`.compile(
			db
		)
	);
	for (const pointer of original.cleared_pointers)
		queries.push(
			sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,payload,created_at)
			SELECT ${`evt_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`},${actor.userId},'workflow.updated',${actor.userId},${actor.apiKeyId},${JSON.stringify({ child_state_id: pointer.child_state_id, restored_parent_state_id: pointer.parent_state_id, retirement_receipt_id: rollbackId, rollback_of_receipt_id: original.id })},${now} WHERE ${receiptGate}`.compile(
				db
			)
		);
	queries.push(
		sql`SELECT receipt_json FROM state_retirement_receipt WHERE id=${rollbackId} AND user_id=${actor.userId} AND request_digest=${requestDigest}`.compile(
			db
		)
	);
	const results = await runAtomic(env as Env, queries);
	if (Number(results[0]?.meta.changes ?? 0) !== 1)
		throw new ApiFail(
			409,
			'retirement_rollback_refused',
			'The receipt witness changed; nothing was reversed'
		);
	const committed = results.at(-1)?.results?.[0] as { receipt_json?: string } | undefined;
	if (!committed?.receipt_json)
		throw new ApiFail(
			503,
			'retirement_outcome_unknown',
			'Rollback outcome is unknown; retry the same signed authorization'
		);
	return parseReceipt(committed as { receipt_json: string });
}

/** Acquire the durable drain before any preservation plan is prepared. */
export async function acquireStateRetirementHold(
	db: Kysely<Database>,
	env: RetirementEnv,
	actor: ActorContext,
	request: AcquireStateRetirementHoldRequest,
	now = Date.now()
): Promise<StateRetirementHold> {
	retiredOperation('new hold acquisition', env);
	if (actor.agentRunId)
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot manage state-retirement holds');
	if (
		!request ||
		typeof request !== 'object' ||
		Object.keys(request).length < 2 ||
		Object.keys(request).length > 3 ||
		Object.keys(request).some(
			(key) => !['inventory_json', 'confirmation', 'receipt_id'].includes(key)
		) ||
		typeof request.inventory_json !== 'string' ||
		!request.confirmation ||
		typeof request.confirmation !== 'object' ||
		Object.keys(request.confirmation).length !== 1 ||
		typeof request.confirmation.inventory_digest !== 'string'
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'Expected inventory_json, confirmation.inventory_digest, and optional receipt_id'
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
	let selectedReceipt: StateRetirementReceiptV1 | null = null;
	if (!current.pointers.length && request.receipt_id) {
		selectedReceipt = (await ownedReceipt(db, actor, request.receipt_id)).receipt;
		if (selectedReceipt.kind !== 'preserve' || selectedReceipt.cleared_pointers.length === 0)
			throw new ApiFail(
				409,
				'retirement_receipt_invalid',
				'The selected receipt does not cover a preserved component'
			);
	} else if (!current.pointers.length) {
		throw new ApiFail(
			422,
			'retirement_no_pointers',
			'There are no state-inheritance pointers to retire'
		);
	}
	const pointersToHold = current.pointers.length
		? current.pointers
		: selectedReceipt!.cleared_pointers.map((pointer) => ({
				child_state_id: pointer.child_state_id,
				parent_state_id: pointer.parent_state_id,
				chain: [pointer.parent_state_id, pointer.child_state_id]
			}));

	const stateIds = [...new Set(pointersToHold.flatMap((pointer) => pointer.chain))].sort();
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
		...pointersToHold.map((pointer) =>
			sql`INSERT INTO state_retirement_pointer
				(hold_id,user_id,child_state_id,original_parent_state_id,state_witness,successful_receipt_id)
				SELECT ${holdId},${actor.userId},${pointer.child_state_id},${pointer.parent_state_id},${canonicalizeLibraryValue(states.get(pointer.child_state_id))},${selectedReceipt?.id ?? null}
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
		active_runs: activeRuns,
		...(selectedReceipt ? { receipt_id: selectedReceipt.id } : {})
	};
}
