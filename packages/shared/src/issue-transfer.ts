import type { EffectiveContext } from './types.js';

export type TransferConflictParticipant = {
	item_id: string;
	name: string | null;
	scope_label: string | null;
};

export type TransferConflictDelta = {
	key: string;
	change: 'retained' | 'resolved' | 'introduced';
	dir: string;
	before: TransferConflictParticipant[];
	after: TransferConflictParticipant[];
};

type ConflictContext = Pick<EffectiveContext, 'repos' | 'conflicts'>;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function conflictsByKey(context: ConflictContext) {
	const repositories = new Map(context.repos.map((repo) => [repo.item_id, repo]));
	return new Map(
		context.conflicts.map((conflict) => {
			const ids = [...new Set(conflict.item_ids)].sort(compare);
			const key = JSON.stringify([conflict.dir, ids]);
			return [
				key,
				{
					dir: conflict.dir,
					participants: ids.map((item_id) => {
						const repo = repositories.get(item_id);
						return {
							item_id,
							name: repo?.name ?? null,
							scope_label: repo?.scope.label ?? null
						};
					})
				}
			] as const;
		})
	);
}

/** Classify the exact repository checkout conflicts visible before and after a transfer. */
export function deriveTransferConflictDeltas(
	before: ConflictContext,
	after: ConflictContext
): TransferConflictDelta[] {
	const beforeByKey = conflictsByKey(before);
	const afterByKey = conflictsByKey(after);
	const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
	const rank = { retained: 0, resolved: 1, introduced: 2 } as const;

	return [...keys]
		.map((key): TransferConflictDelta => {
			const oldConflict = beforeByKey.get(key);
			const newConflict = afterByKey.get(key);
			return {
				key,
				change: oldConflict && newConflict ? 'retained' : oldConflict ? 'resolved' : 'introduced',
				dir: (oldConflict ?? newConflict)!.dir,
				before: oldConflict?.participants ?? [],
				after: newConflict?.participants ?? []
			};
		})
		.sort(
			(a, b) => rank[a.change] - rank[b.change] || compare(a.dir, b.dir) || compare(a.key, b.key)
		);
}
