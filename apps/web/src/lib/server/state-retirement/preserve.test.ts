import { describe, expect, it } from 'vitest';
import type { StateRetirementInventoryV1 } from '@tines/shared';
import { planStateRetirement } from './preserve';

const state = (id: string, parent: string | null, name = id) => ({
	id,
	workflow_id: 'wf',
	name,
	category: 'active',
	position: 0,
	inherits_from_state_id: parent,
	created_at: 1
});

const item = (
	id: string,
	kind: string,
	name: string,
	stateId: string | null,
	position: number,
	extra: Record<string, unknown> = {}
) => ({
	id,
	kind,
	name,
	description: `${name} description`,
	project_id: 'project',
	workflow_state_id: stateId,
	label_id: null,
	issue_id: null,
	body: kind === 'prompt' ? `${name} exact bytes\n` : null,
	repo_url: kind === 'repo' ? 'https://example.test/source.git' : null,
	repo_branch: kind === 'repo' ? 'main' : null,
	repo_dir: kind === 'repo' ? 'source' : null,
	config: null,
	position,
	version: 3,
	created_at: position + 10,
	updated_at: position + 10,
	...extra
});

function fixture(): StateRetirementInventoryV1 {
	const states = [
		state('root', null, 'Craft'),
		state('mid', 'root', 'Middle'),
		state('building', 'root', 'Building'),
		state('critiquing', 'root', 'Critiquing'),
		state('fanning', 'root', 'Fanning out'),
		state('gathering', 'mid', 'Gathering'),
		state('polishing', 'root', 'Polishing')
	];
	const pointers = states
		.filter((entry) => entry.inherits_from_state_id)
		.map((entry) => ({
			child_state_id: entry.id,
			parent_state_id: entry.inherits_from_state_id!,
			chain: entry.id === 'gathering' ? ['gathering', 'mid', 'root'] : [entry.id, 'root']
		}));
	return {
		version: 1,
		owner_id: 'user',
		captured_at: 100,
		inventory_digest: 'sha256:inventory',
		topology_digest: 'sha256:topology',
		diagnostics: [],
		pointers,
		witness: {
			workflows: [{ id: 'wf', user_id: 'user', name: 'Design Craft' }],
			states,
			transitions: [],
			projects: [{ id: 'project', name: 'Tines' }],
			labels: [],
			issues: [],
			issue_labels: [],
			context_items: [
				item('root-instructions', 'prompt', 'instructions', 'root', -2),
				item('root-journal', 'prompt', 'journal', 'root', -1),
				item('mid-guidance', 'prompt', 'mid-guidance', 'mid', -2),
				item('existing-journal', 'prompt', 'journal', 'gathering', 0),
				item('root-skill', 'skill', 'review-skill', 'root', 0),
				item('root-repo', 'repo', 'source', 'root', 1)
			],
			context_files: [
				{
					id: 'root-file',
					context_item_id: 'root-skill',
					path: 'SKILL.md',
					content: '# exact\n',
					created_at: 1,
					updated_at: 1
				}
			],
			active_runs: [{ id: 'finished', state_id_at_start: 'building', status: 'completed' }]
		}
	};
}

describe('pure state-retirement preservation planner', () => {
	it('agrees across the historical five-consumer fan-out and preserves multilevel/local journals', () => {
		const plan = planStateRetirement(fixture());

		expect(plan.applyable).toBe(true);
		expect(plan.held_states).toEqual([
			'building',
			'critiquing',
			'fanning',
			'gathering',
			'mid',
			'polishing',
			'root'
		]);
		expect(plan.active_run_ids).toEqual(['finished']);
		expect(plan.proposed_operations.filter((op) => op.kind === 'clear_pointer')).toHaveLength(6);
		expect(
			plan.proposed_operations.filter((op) => op.kind === 'copy_context_item').length
		).toBeGreaterThanOrEqual(12);
		expect(plan.allocations.some((allocation) => allocation.name === 'journal')).toBe(true);
		expect(
			plan.allocations.some((allocation) => allocation.name.startsWith('Journal snapshot —'))
		).toBe(true);
		expect(
			plan.allocations.some(
				(allocation) => allocation.name === 'Craft guidance — preserved from Design Craft / Craft'
			)
		).toBe(true);
		expect(
			plan.allocations.every(
				(allocation) => allocation.position < 0 || allocation.scope.workflow_state_id !== 'root'
			)
		).toBe(true);
		expect(plan.rollback.source_item_ids).toContain('root-instructions');
		expect(plan.rollback.source_file_ids).toContain('root-file');
	});

	it('refuses inherited env and unknown contributing kinds without serializing values', () => {
		const inventory = fixture();
		inventory.witness.context_items.push(
			item('secret-env', 'env', 'SECRET_TOKEN', 'root', 3, {
				env_secret: 1,
				env_hint: 'redacted',
				env_value: 'do-not-copy',
				env_value_enc: 'ciphertext-do-not-copy'
			}),
			item('unknown-kind', 'future_kind', 'future', 'root', 4)
		);
		const plan = planStateRetirement(inventory);

		expect(plan.applyable).toBe(false);
		expect(plan.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(['retirement_inherited_env', 'retirement_unsupported_kind'])
		);
		expect(JSON.stringify(plan)).not.toContain('do-not-copy');
		expect(JSON.stringify(plan)).not.toContain('ciphertext-do-not-copy');
	});

	it('refuses target enumeration and repository collision bounds before producing operations', () => {
		const inventory = fixture();
		inventory.witness.context_items.push(
			item('repo-conflict', 'repo', 'other', 'root', 2, { repo_dir: 'source' })
		);
		const plan = planStateRetirement(inventory, { max_targets: 1 });

		expect(plan.applyable).toBe(false);
		expect(plan.proposed_operations).toEqual([]);
		expect(
			plan.diagnostics.some((diagnostic) => diagnostic.code === 'retirement_enumeration_bound')
		).toBe(true);
	});
});
