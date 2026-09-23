import type {
	StateRetirementDiagnostic,
	StateRetirementInventoryV1,
	StateRetirementWitnessV1
} from '@tines/shared';
import { canonicalizeLibraryValue } from '@tines/shared';
import type { Kysely } from 'kysely';
import { sha256Hex } from '$lib/server/crypto';
import type { Database } from '$lib/server/db';
import { ApiFail, type ActorContext } from '$lib/server/api/core';
import { readRetirementWitness } from './queries';

type StateRow = {
	id: string;
	workflow_id: string;
	inherits_from_state_id: string | null;
};
type WorkflowRow = { id: string; user_id: string | null };

const digest = async (value: string) => `sha256:${await sha256Hex(value)}`;
const INVENTORY_MAX_BYTES = 5 * 1024 * 1024;

function topology(witness: StateRetirementWitnessV1, ownerId: string) {
	const states = new Map((witness.states as StateRow[]).map((state) => [state.id, state]));
	const workflows = new Map(
		(witness.workflows as WorkflowRow[]).map((workflow) => [workflow.id, workflow])
	);
	const diagnostics: StateRetirementDiagnostic[] = [];
	const pointers: StateRetirementInventoryV1['pointers'] = [];

	for (const child of (witness.states as StateRow[]).filter((state) => {
		return (
			state.inherits_from_state_id !== null && workflows.get(state.workflow_id)?.user_id === ownerId
		);
	})) {
		const chain = [child.id];
		const seen = new Set(chain);
		let cursor = child;
		while (cursor.inherits_from_state_id !== null) {
			const parentId = cursor.inherits_from_state_id;
			if (seen.has(parentId)) {
				diagnostics.push({
					code: 'state_inheritance_cycle',
					state_id: child.id,
					parent_state_id: parentId,
					message: `State inheritance cycle reaches ${parentId}`
				});
				break;
			}
			const parent = states.get(parentId);
			if (!parent) {
				diagnostics.push({
					code: 'dangling_state_parent',
					state_id: child.id,
					parent_state_id: parentId,
					message: `Inherited state ${parentId} is missing`
				});
				break;
			}
			const parentOwner = workflows.get(parent.workflow_id)?.user_id;
			if (parentOwner !== null && parentOwner !== ownerId) {
				diagnostics.push({
					code: 'foreign_state_parent',
					state_id: child.id,
					parent_state_id: parentId,
					message: `Inherited state ${parentId} is not owned by this account`
				});
				break;
			}
			chain.push(parentId);
			seen.add(parentId);
			cursor = parent;
		}
		pointers.push({
			child_state_id: child.id,
			parent_state_id: child.inherits_from_state_id!,
			chain
		});
	}
	return { diagnostics, pointers };
}

/** Read twice so an inventory never combines rows from two database versions. */
export async function createStateRetirementInventory(
	db: Kysely<Database>,
	actor: ActorContext,
	now = Date.now()
): Promise<StateRetirementInventoryV1> {
	if (actor.agentRunId) {
		throw new ApiFail(403, 'run_key_forbidden', 'Run keys cannot inspect state-retirement plans');
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = await readRetirementWitness(db, actor.userId);
		if (new TextEncoder().encode(before).byteLength > INVENTORY_MAX_BYTES) {
			throw new ApiFail(
				422,
				'retirement_inventory_too_large',
				'State retirement inventory exceeds the 5 MiB review limit'
			);
		}
		const witness = JSON.parse(before) as StateRetirementWitnessV1;
		const { diagnostics, pointers } = topology(witness, actor.userId);
		const after = await readRetirementWitness(db, actor.userId);
		if (before !== after) continue;
		const topologyJson = canonicalizeLibraryValue(
			pointers.map(({ child_state_id, parent_state_id }) => ({ child_state_id, parent_state_id }))
		);
		return {
			version: 1,
			owner_id: actor.userId,
			captured_at: now,
			inventory_digest: await digest(before),
			topology_digest: await digest(topologyJson),
			diagnostics,
			pointers,
			witness
		};
	}
	throw new ApiFail(
		503,
		'inventory_unstable',
		'State retirement inventory changed while it was being read; retry'
	);
}
