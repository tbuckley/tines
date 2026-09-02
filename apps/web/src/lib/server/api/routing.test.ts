import { describe, expect, it } from 'vitest';
import { api, ApiFail, runAtomic, type ActorContext } from './core';
import { createTestDb } from './test-db';
import {
	createRoutingRule,
	findScopeCollision,
	ruleScopesOverlap,
	ruleSpecificity,
	shadowWarnings,
	validateTargets,
	type RuleForShadowing
} from './routing';

describe('ruleSpecificity', () => {
	it('orders project ∧ state > project > state > global', () => {
		const scopes = [
			{}, // global
			{ workflowStateId: 's' }, // state
			{ projectId: 'p' }, // project — deliberately above state, unlike context
			{ projectId: 'p', workflowStateId: 's' } // project ∧ state
		];
		expect(scopes.map(ruleSpecificity)).toEqual([0, 1, 2, 3]);
	});
});

describe('ruleScopesOverlap', () => {
	const global = { projectId: null, workflowStateId: null };
	const projectA = { projectId: 'pA', workflowStateId: null };
	const projectB = { projectId: 'pB', workflowStateId: null };
	const stateReview = { projectId: null, workflowStateId: 'sR' };
	const comboAReview = { projectId: 'pA', workflowStateId: 'sR' };

	it('global overlaps everything', () => {
		for (const scope of [global, projectA, stateReview, comboAReview]) {
			expect(ruleScopesOverlap(global, scope)).toBe(true);
		}
	});

	it('a project rule overlaps a state rule (some issue can match both)', () => {
		expect(ruleScopesOverlap(projectA, stateReview)).toBe(true);
	});

	it('two different projects never overlap', () => {
		expect(ruleScopesOverlap(projectA, projectB)).toBe(false);
	});

	it('a combo overlaps only compatible dimensions', () => {
		expect(ruleScopesOverlap(comboAReview, projectA)).toBe(true);
		expect(ruleScopesOverlap(comboAReview, stateReview)).toBe(true);
		expect(ruleScopesOverlap(comboAReview, projectB)).toBe(false);
		expect(ruleScopesOverlap(comboAReview, { projectId: 'pA', workflowStateId: 'sOther' })).toBe(
			false
		);
	});
});

describe('shadowWarnings', () => {
	const rules: RuleForShadowing[] = [
		{ id: 'r_global', projectId: null, workflowStateId: null, label: 'global' },
		{ id: 'r_acme', projectId: 'p_acme', workflowStateId: null, label: 'project acme' },
		{ id: 'r_review', projectId: null, workflowStateId: 's_review', label: 'state Review' },
		{
			id: 'r_acme_review',
			projectId: 'p_acme',
			workflowStateId: 's_review',
			label: 'project acme · state Review'
		}
	];

	it('saving a state rule warns that project rules take precedence for their projects', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: null, workflowStateId: 's_open' },
			rules
		);
		const shadowedBy = warnings.filter((w) => w.message.includes('instead of this rule'));
		expect(shadowedBy.map((w) => w.rule_id)).toEqual(['r_acme']);
		// The state Open rule itself outranks only the global rule.
		const shadows = warnings.filter((w) => w.message.includes('takes precedence over'));
		expect(shadows.map((w) => w.rule_id)).toEqual(['r_global']);
	});

	it('saving a project rule warns both ways: shadowed by the combo, shadowing state + global', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: 'p_web', workflowStateId: null },
			rules
		);
		// The acme combo can never match p_web issues; only overlapping rules warn.
		expect(warnings.map((w) => w.rule_id).sort()).toEqual(['r_global', 'r_review']);
		expect(warnings.every((w) => w.message.includes('takes precedence over'))).toBe(true);

		const acmeWarnings = shadowWarnings(
			{ id: 'r_x', projectId: 'p_acme', workflowStateId: null },
			rules
		);
		const shadowedBy = acmeWarnings.find((w) => w.rule_id === 'r_acme_review');
		expect(shadowedBy?.message).toContain('more specific');
	});

	it('excludes the rule being saved and same-scope rules', () => {
		const warnings = shadowWarnings(
			{ id: 'r_acme', projectId: 'p_acme', workflowStateId: null },
			rules
		);
		expect(warnings.map((w) => w.rule_id)).not.toContain('r_acme');
	});

	it('a combo rule shadows every broader overlapping rule', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: 'p_web', workflowStateId: 's_review' },
			rules
		);
		expect(warnings.map((w) => w.rule_id).sort()).toEqual(['r_global', 'r_review']);
	});
});

describe('findScopeCollision', () => {
	const rules = [
		{ id: 'r_global', projectId: null, workflowStateId: null },
		{ id: 'r_acme', projectId: 'p_acme', workflowStateId: null }
	];

	it('finds the rule at the same exact scope', () => {
		expect(findScopeCollision({ projectId: null, workflowStateId: null }, rules)?.id).toBe(
			'r_global'
		);
		expect(findScopeCollision({ projectId: 'p_acme', workflowStateId: null }, rules)?.id).toBe(
			'r_acme'
		);
	});

	it('a different exact scope is not a collision, even when scopes overlap', () => {
		expect(
			findScopeCollision({ projectId: 'p_acme', workflowStateId: 's_review' }, rules)
		).toBeUndefined();
	});

	it('excludes the rule being updated', () => {
		expect(
			findScopeCollision({ projectId: 'p_acme', workflowStateId: null }, rules, 'r_acme')
		).toBeUndefined();
	});
});

describe('validateTargets', () => {
	const runners = new Map([
		['rnr_1', { id: 'rnr_1', name: 'laptop-m4' }],
		['rnr_2', { id: 'rnr_2', name: 'claude' }]
	]);

	it('accepts an ordered list and normalizes absent tiers', () => {
		const targets = validateTargets(
			[{ runner_id: 'rnr_2', tier: 'cheapest' }, { runner_id: 'rnr_1' }],
			runners
		);
		expect(targets).toEqual([{ runner_id: 'rnr_2', tier: 'cheapest' }, { runner_id: 'rnr_1' }]);
	});

	it('rejects an empty list', () => {
		expect(() => validateTargets([], runners)).toThrowError(ApiFail);
	});

	it("rejects a runner that isn't the user's", () => {
		try {
			validateTargets([{ runner_id: 'rnr_theirs' }], runners);
			throw new Error('expected a 422');
		} catch (e) {
			expect((e as ApiFail).code).toBe('unknown_runner');
		}
	});

	it('rejects a tier outside the closed set', () => {
		try {
			validateTargets([{ runner_id: 'rnr_1', tier: 'galaxy-brain' }], runners);
			throw new Error('expected a 422');
		} catch (e) {
			expect((e as ApiFail).code).toBe('unknown_tier');
		}
	});

	it('rejects exact duplicate entries but allows the same runner on different tiers', () => {
		expect(() =>
			validateTargets(
				[
					{ runner_id: 'rnr_2', tier: 'cheapest' },
					{ runner_id: 'rnr_2', tier: 'cheapest' }
				],
				runners
			)
		).toThrowError(ApiFail);
		expect(
			validateTargets(
				[
					{ runner_id: 'rnr_2', tier: 'cheapest' },
					{ runner_id: 'rnr_2', tier: 'smartest' }
				],
				runners
			)
		).toHaveLength(2);
	});
});

describe('rule scope state category', () => {
	const actor: ActorContext = {
		userId: 'u1',
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};

	function seed() {
		const t = createTestDb();
		const now = 1_723_000_000_000;
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u1', 'alice', 'a@example.com', 1, ${now}, ${now});
			INSERT INTO runner (id, user_id, type, name, config, created_at, updated_at)
				VALUES ('rnr_1', 'u1', 'local', 'laptop-m4', '{}', ${now}, ${now});
			INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at)
				VALUES ('wfs_std_icebox', 'wf_standard', 'Icebox', 'backlog', 3, ${now});
		`);
		return t;
	}

	it('rejects scoping to backlog, awaiting-human, and done states — agents never pick those up', async () => {
		const t = seed();
		// The seeded standard workflow: Human Review (awaiting_human), Closed
		// (done), plus the backlog state added above.
		for (const stateId of ['wfs_std_review', 'wfs_std_closed', 'wfs_std_icebox']) {
			await expect(
				createRoutingRule(t.db, t.env, actor, {
					workflow_state_id: stateId,
					targets: [{ runner_id: 'rnr_1' }]
				})
			).rejects.toMatchObject({ status: 422, code: 'state_not_dispatchable' });
		}
		expect(t.all(`SELECT id FROM routing_rule`)).toEqual([]);
	});

	it('accepts an active-category state', async () => {
		const t = seed();
		const rule = await createRoutingRule(t.db, t.env, actor, {
			workflow_state_id: 'wfs_std_open',
			targets: [{ runner_id: 'rnr_1' }]
		});
		expect(rule.scope.workflow_state_id).toBe('wfs_std_open');
		expect(rule.scope.label).toBe('state Open');
	});
});

describe('scope-collision unique-index backstop', () => {
	it('maps the racing insert that slipped past the app-level check to a 409', async () => {
		const t = createTestDb();
		const now = 1_723_000_000_000;
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u1', 'alice', 'a@example.com', 1, ${now}, ${now});
			INSERT INTO runner (id, user_id, type, name, config, created_at, updated_at)
				VALUES ('rnr_1', 'u1', 'local', 'laptop-m4', '{}', ${now}, ${now});
		`);
		const globalRule = (id: string) =>
			t.db
				.insertInto('routing_rule')
				.values({
					id,
					user_id: 'u1',
					project_id: null,
					workflow_state_id: null,
					targets: '[{"runner_id":"rnr_1"}]',
					created_at: now,
					updated_at: now
				})
				.compile();

		// Both creates passed assertNoScopeCollision (neither saw the other);
		// the loser's insert must die on routing_rule_scope_uq and surface as
		// the api() wrapper's structured 409, not a 500.
		await runAtomic(t.env, [globalRule('rul_winner')]);
		const loser = api(async () => {
			await runAtomic(t.env, [globalRule('rul_loser')]);
			return new Response('created');
		});
		const res = await loser({} as never);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe('conflict');
		expect(t.all(`SELECT id FROM routing_rule`).map((r) => r.id)).toEqual(['rul_winner']);
	});
});
