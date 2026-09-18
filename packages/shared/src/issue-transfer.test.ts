import { describe, expect, it } from 'vitest';
import { deriveTransferConflictDeltas } from './issue-transfer.js';

const scope = (label: string) => ({ label });
const repo = (item_id: string, name: string, label: string) => ({
	item_id,
	name,
	scope: scope(label),
	url: `https://example.test/${name}.git`,
	dir: name,
	version: 1,
	inherited_from: null
});
const context = (
	repos: ReturnType<typeof repo>[],
	conflicts: { kind: 'repo_dir'; dir: string; item_ids: string[] }[]
) => ({ repos, conflicts });

describe('deriveTransferConflictDeltas', () => {
	it('classifies retained, resolved and introduced conflicts deterministically', () => {
		const before = context(
			[repo('b', 'bravo', 'source'), repo('a', 'alpha', 'issue'), repo('c', 'charlie', 'source')],
			[
				{ kind: 'repo_dir', dir: 'same', item_ids: ['b', 'a'] },
				{ kind: 'repo_dir', dir: 'changed', item_ids: ['a', 'c'] },
				{ kind: 'repo_dir', dir: 'moved-before', item_ids: ['a', 'b'] }
			]
		);
		const after = context(
			[
				repo('a', 'alpha', 'destination issue'),
				repo('b', 'bravo', 'destination'),
				repo('d', 'delta', 'destination')
			],
			[
				{ kind: 'repo_dir', dir: 'same', item_ids: ['a', 'b'] },
				{ kind: 'repo_dir', dir: 'changed', item_ids: ['a', 'd'] },
				{ kind: 'repo_dir', dir: 'moved-after', item_ids: ['a', 'b'] }
			]
		);
		const frozenBefore = structuredClone(before);
		const frozenAfter = structuredClone(after);

		const deltas = deriveTransferConflictDeltas(before as never, after as never);

		expect(deltas.map(({ change, dir }) => ({ change, dir }))).toEqual([
			{ change: 'retained', dir: 'same' },
			{ change: 'resolved', dir: 'changed' },
			{ change: 'resolved', dir: 'moved-before' },
			{ change: 'introduced', dir: 'changed' },
			{ change: 'introduced', dir: 'moved-after' }
		]);
		expect(deltas[0]).toMatchObject({
			before: [
				{ item_id: 'a', name: 'alpha', scope_label: 'issue' },
				{ item_id: 'b', name: 'bravo', scope_label: 'source' }
			],
			after: [
				{ item_id: 'a', name: 'alpha', scope_label: 'destination issue' },
				{ item_id: 'b', name: 'bravo', scope_label: 'destination' }
			]
		});
		expect(before).toEqual(frozenBefore);
		expect(after).toEqual(frozenAfter);
	});

	it('handles empty sides and preserves unknown participant IDs', () => {
		const before = context([], [{ kind: 'repo_dir', dir: 'lost', item_ids: ['unknown'] }]);
		const deltas = deriveTransferConflictDeltas(before as never, context([], []) as never);
		expect(deltas).toEqual([
			expect.objectContaining({
				change: 'resolved',
				dir: 'lost',
				before: [{ item_id: 'unknown', name: null, scope_label: null }],
				after: []
			})
		]);
		expect(
			deriveTransferConflictDeltas(context([], []) as never, context([], []) as never)
		).toEqual([]);
	});

	it('does not resolve participants from overridden candidates', () => {
		const value = {
			...context([], [{ kind: 'repo_dir' as const, dir: 'app', item_ids: ['loser'] }]),
			overridden: [{ item_id: 'loser', name: 'hidden', scope: scope('project') }]
		};
		expect(deriveTransferConflictDeltas(value as never, value as never)[0]?.before).toEqual([
			{ item_id: 'loser', name: null, scope_label: null }
		]);
	});
});
