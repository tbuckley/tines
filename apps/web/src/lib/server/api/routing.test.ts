import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it } from 'vitest';
import { addLabel, addRunner, OPEN, PROJECT, seedBase, USER } from '../supervisor/test-fixtures';
import { api, ApiFail, runAtomic, type ActorContext } from './core';
import { createTestDb, type TestDb } from './test-db';
import {
	createRoutingRule,
	deleteRoutingRule,
	findScopeCollision,
	listRoutingRules,
	routingRulesForProject,
	ruleScopesOverlap,
	ruleSpecificity,
	shadowWarnings,
	updateRoutingRule,
	validateTargets,
	type RuleForShadowing
} from './routing';

describe('ruleSpecificity', () => {
	it('orders the eight scopes, label above project above state', () => {
		const scopes = [
			{}, // global
			{ workflowStateId: 's', labelId: null }, // state
			{ projectId: 'p' }, // project — deliberately above state, unlike context
			{ projectId: 'p', workflowStateId: 's', labelId: null }, // project ∧ state
			{ labelId: 'l' }, // label
			{ labelId: 'l', workflowStateId: 's' },
			{ labelId: 'l', projectId: 'p' },
			{ labelId: 'l', projectId: 'p', workflowStateId: 's' }
		];
		expect(scopes.map(ruleSpecificity)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it('adding label left every pre-label scope at its old rank', () => {
		// The point of the high bit: no rule that existed before labels
		// changed rank, so nothing silently re-routed when the column landed.
		expect(ruleSpecificity({ workflowStateId: 's', labelId: null })).toBe(1);
		expect(ruleSpecificity({ projectId: 'p', labelId: null })).toBe(2);
		expect(ruleSpecificity({ projectId: 'p', workflowStateId: 's', labelId: null })).toBe(3);
	});

	it('a bare label rule outranks project ∧ state', () => {
		// "anything labelled security stays on the laptop" has to beat a
		// project rule, or the guarantee is not one.
		expect(ruleSpecificity({ labelId: 'l' })).toBeGreaterThan(
			ruleSpecificity({ projectId: 'p', workflowStateId: 's', labelId: null })
		);
	});
});

describe('ruleScopesOverlap', () => {
	const global = { projectId: null, workflowStateId: null, labelId: null };
	const projectA = { projectId: 'pA', workflowStateId: null, labelId: null };
	const projectB = { projectId: 'pB', workflowStateId: null, labelId: null };
	const stateReview = { projectId: null, workflowStateId: 'sR', labelId: null };
	const comboAReview = { projectId: 'pA', workflowStateId: 'sR', labelId: null };

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

	it('two different labels always overlap — an issue carries a set of them', () => {
		// The one place labels differ from every other dimension, and the
		// reason equal-specificity ties became reachable.
		const design = { projectId: null, workflowStateId: null, labelId: 'l_design' };
		const qa = { projectId: null, workflowStateId: null, labelId: 'l_qa' };
		expect(ruleScopesOverlap(design, qa)).toBe(true);
		// A conflicting project still makes them disjoint, label or not.
		expect(ruleScopesOverlap({ ...design, projectId: 'pA' }, { ...qa, projectId: 'pB' })).toBe(
			false
		);
	});

	it('a combo overlaps only compatible dimensions', () => {
		expect(ruleScopesOverlap(comboAReview, projectA)).toBe(true);
		expect(ruleScopesOverlap(comboAReview, stateReview)).toBe(true);
		expect(ruleScopesOverlap(comboAReview, projectB)).toBe(false);
		expect(
			ruleScopesOverlap(comboAReview, { projectId: 'pA', workflowStateId: 'sOther', labelId: null })
		).toBe(false);
	});
});

describe('shadowWarnings', () => {
	const rules: RuleForShadowing[] = [
		{ id: 'r_global', projectId: null, workflowStateId: null, labelId: null, label: 'global' },
		{
			id: 'r_acme',
			projectId: 'p_acme',
			workflowStateId: null,
			labelId: null,
			label: 'project acme'
		},
		{
			id: 'r_review',
			projectId: null,
			workflowStateId: 's_review',
			labelId: null,
			label: 'state Review'
		},
		{
			id: 'r_acme_review',
			projectId: 'p_acme',
			workflowStateId: 's_review',
			labelId: null,
			label: 'project acme · state Review'
		}
	];

	it('two rules differing only by label tie, and saving either warns', () => {
		const design: RuleForShadowing = {
			id: 'r_design',
			projectId: null,
			workflowStateId: null,
			labelId: 'l_design',
			label: 'label design'
		};
		const qa: RuleForShadowing = {
			id: 'r_qa',
			projectId: null,
			workflowStateId: null,
			labelId: 'l_qa',
			label: 'label qa'
		};
		const warnings = shadowWarnings({ ...design }, [qa]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].kind).toBe('ambiguous');
		expect(warnings[0].rule_id).toBe('r_qa');
		expect(warnings[0].message).toContain('will not dispatch');
	});

	it('does not call a project rule ambiguous with a same-rank project rule', () => {
		// Equal specificity is only reachable through labels: two project
		// rules of the same rank name different projects and so cannot both
		// match, and shadowWarnings must still skip them entirely.
		expect(
			shadowWarnings({ id: 'r_a', projectId: 'pA', workflowStateId: null, labelId: null }, [
				{ id: 'r_b', projectId: 'pB', workflowStateId: null, labelId: null, label: 'project B' }
			])
		).toEqual([]);
	});

	it('saving a state rule warns that project rules take precedence for their projects', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: null, workflowStateId: 's_open', labelId: null },
			rules
		);
		const shadowedBy = warnings.filter((w) => w.kind === 'shadowed');
		expect(shadowedBy.map((w) => w.rule_id)).toEqual(['r_acme']);
		// The state Open rule itself outranks only the global rule.
		const shadows = warnings.filter((w) => w.kind === 'shadows');
		expect(shadows.map((w) => w.rule_id)).toEqual(['r_global']);
	});

	it('saving a project rule warns both ways: shadowed by the combo, shadowing state + global', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: 'p_web', workflowStateId: null, labelId: null },
			rules
		);
		// The acme combo can never match p_web issues; only overlapping rules warn.
		expect(warnings.map((w) => w.rule_id).sort()).toEqual(['r_global', 'r_review']);
		expect(warnings.every((w) => w.kind === 'shadows')).toBe(true);

		const acmeWarnings = shadowWarnings(
			{ id: 'r_x', projectId: 'p_acme', workflowStateId: null, labelId: null },
			rules
		);
		const shadowedBy = acmeWarnings.find((w) => w.rule_id === 'r_acme_review');
		expect(shadowedBy?.message).toContain('higher priority');
	});

	it('excludes the rule being saved and same-scope rules', () => {
		const warnings = shadowWarnings(
			{ id: 'r_acme', projectId: 'p_acme', workflowStateId: null, labelId: null },
			rules
		);
		expect(warnings.map((w) => w.rule_id)).not.toContain('r_acme');
	});

	it('a combo rule shadows every broader overlapping rule', () => {
		const warnings = shadowWarnings(
			{ id: 'r_new', projectId: 'p_web', workflowStateId: 's_review', labelId: null },
			rules
		);
		expect(warnings.map((w) => w.rule_id).sort()).toEqual(['r_global', 'r_review']);
	});
});

describe('findScopeCollision', () => {
	const rules = [
		{ id: 'r_global', projectId: null, workflowStateId: null, labelId: null },
		{ id: 'r_acme', projectId: 'p_acme', workflowStateId: null, labelId: null }
	];

	it('finds the rule at the same exact scope', () => {
		expect(
			findScopeCollision({ projectId: null, workflowStateId: null, labelId: null }, rules)?.id
		).toBe('r_global');
		expect(
			findScopeCollision({ projectId: 'p_acme', workflowStateId: null, labelId: null }, rules)?.id
		).toBe('r_acme');
	});

	it('a different exact scope is not a collision, even when scopes overlap', () => {
		expect(
			findScopeCollision({ projectId: 'p_acme', workflowStateId: 's_review', labelId: null }, rules)
		).toBeUndefined();
	});

	it('excludes the rule being updated', () => {
		expect(
			findScopeCollision(
				{ projectId: 'p_acme', workflowStateId: null, labelId: null },
				rules,
				'r_acme'
			)
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

	it('accepts a singleton tier-only target and rejects incomplete or mixed forms', () => {
		expect(validateTargets([{ runner_id: '*', tier: 'smartest' }], runners)).toEqual([
			{ runner_id: '*', tier: 'smartest' }
		]);
		expect(() => validateTargets([{ runner_id: '*' }], runners)).toThrowError(ApiFail);
		expect(() =>
			validateTargets([{ runner_id: '*', tier: 'balanced' }, { runner_id: 'rnr_1' }], runners)
		).toThrowError(ApiFail);
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
				createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
					workflow_state_id: stateId,
					targets: [{ runner_id: 'rnr_1' }]
				})
			).rejects.toMatchObject({ status: 422, code: 'state_not_dispatchable' });
		}
		expect(t.all(`SELECT id FROM routing_rule`)).toEqual([]);
	});

	it('accepts an active-category state', async () => {
		const t = seed();
		const rule = await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			workflow_state_id: 'wfs_std_open',
			targets: [{ runner_id: 'rnr_1' }]
		});
		expect(rule.scope.workflow_state_id).toBe('wfs_std_open');
		expect(rule.scope.label).toBe('state Open');
	});

	it('dispatch effects: routing owners signal successes and keep rejections silent', async () => {
		const t = seed();
		const effects = recordDispatchEffects();
		const rule = await createRoutingRule(t.db, t.env, actor, effects, {
			workflow_state_id: 'wfs_std_open',
			targets: [{ runner_id: 'rnr_1' }]
		});
		expect(effects.count()).toBe(1);
		await updateRoutingRule(t.db, t.env, actor, effects, rule.id, {
			targets: [{ runner_id: 'rnr_1' }]
		});
		expect(effects.count()).toBe(2);
		await expect(
			deleteRoutingRule(t.db, t.env, actor, effects, 'rul_missing')
		).rejects.toMatchObject({ status: 404 });
		expect(effects.count()).toBe(2);
		await deleteRoutingRule(t.db, t.env, actor, effects, rule.id);
		expect(effects.count()).toBe(3);
	});

	it('accepts a scoped tier-only rule, serializes its sentinel, and rejects a global one', async () => {
		const t = seed();
		await expect(
			createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
				targets: [{ runner_id: '*', tier: 'smartest' }]
			})
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
		const rule = await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			workflow_state_id: 'wfs_std_open',
			targets: [{ runner_id: '*', tier: 'smartest' }]
		});
		expect(rule.targets).toEqual([
			{ runner_id: '*', runner_name: '*', runner_status: null, tier: 'smartest' }
		]);
	});

	it('rejects an update that makes a tier-only rule global', async () => {
		const t = seed();
		const rule = await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			workflow_state_id: 'wfs_std_open',
			targets: [{ runner_id: '*', tier: 'smartest' }]
		});
		await expect(
			updateRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, rule.id, {
				workflow_state_id: null
			})
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
		expect((await listRoutingRules(t.db, actor.userId))[0].scope.workflow_state_id).toBe(
			'wfs_std_open'
		);
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

describe('listRoutingRules', () => {
	const actor: ActorContext = {
		userId: USER,
		userName: 'alice',
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	};

	/**
	 * Four overlapping rules over one project, deliberately created in an
	 * order that is neither the specificity order nor alphabetical: global,
	 * then `project ∧ state`, then two bare label rules that tie.
	 */
	async function seedRules(t: TestDb) {
		addRunner(t, { id: 'rnr_1', name: 'laptop' });
		const design = addLabel(t, 'design');
		const docs = addLabel(t, 'docs');
		const targets = [{ runner_id: 'rnr_1' }];
		const ids: Record<string, string> = {};
		ids.global = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, { targets })
		).id;
		ids.combo = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
				project_id: PROJECT,
				workflow_state_id: OPEN,
				targets
			})
		).id;
		ids.design = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
				label_id: design,
				targets
			})
		).id;
		ids.docs = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
				label_id: docs,
				targets
			})
		).id;
		return ids;
	}

	it('sorts most specific first, with label rules above project ∧ state', async () => {
		const t = createTestDb();
		seedBase(t);
		const ids = await seedRules(t);
		// The rank order the dispatcher itself uses. Before labels became the
		// high bit's *sort* input too, the two label rules — the strongest
		// claims on where work runs — sorted last, below global's neighbours.
		expect((await listRoutingRules(t.db, USER)).map((r) => r.id)).toEqual([
			// label design and label docs tie at 4; the label breaks it.
			ids.design,
			ids.docs,
			ids.combo,
			ids.global
		]);
	});

	it('gives each rule the warnings about itself, and drops the redundant `shadows` half', async () => {
		const t = createTestDb();
		seedBase(t);
		const ids = await seedRules(t);
		const byId = new Map((await listRoutingRules(t.db, USER)).map((r) => [r.id, r]));

		// The tie the Agents list has to show: two bare label rules match an
		// issue carrying both equally, so neither dispatches.
		expect(byId.get(ids.design)!.warnings).toEqual([
			expect.objectContaining({ kind: 'ambiguous', rule_id: ids.docs, scope_label: 'label docs' })
		]);
		expect(byId.get(ids.docs)!.warnings.map((w) => w.rule_id)).toEqual([ids.design]);

		// The global rule is outranked by all three, and says so on its own
		// row rather than only in the modal that saved it.
		expect(byId.get(ids.global)!.warnings.map((w) => w.kind)).toEqual([
			'shadowed',
			'shadowed',
			'shadowed'
		]);
		expect(
			byId
				.get(ids.global)!
				.warnings.map((w) => w.scope_label)
				.sort()
		).toEqual(['label design', 'label docs', 'project demo · state Open']);

		// `shadows` is never listed: sorted, it only ever names a rule below,
		// which the order already shows. The combo rule shadows global and is
		// shadowed by both label rules — only the latter two survive.
		expect(byId.get(ids.combo)!.warnings.map((w) => w.kind)).toEqual(['shadowed', 'shadowed']);
		for (const rule of byId.values()) {
			expect(rule.warnings.some((w) => w.kind === 'shadows')).toBe(false);
		}
	});

	it('leaves a lone rule unwarned', async () => {
		const t = createTestDb();
		seedBase(t);
		addRunner(t, { id: 'rnr_1', name: 'laptop' });
		await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			targets: [{ runner_id: 'rnr_1' }]
		});
		expect((await listRoutingRules(t.db, USER))[0].warnings).toEqual([]);
	});

	it('keeps global and matching-project rules while excluding another project', async () => {
		const t = createTestDb();
		seedBase(t);
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('prj_other', '${USER}', 'other', 1723000000000, 1723000000000);
		`);
		addRunner(t, { id: 'rnr_1', name: 'laptop' });
		const targets = [{ runner_id: 'rnr_1' }];
		const global = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, { targets })
		).id;
		const matching = (
			await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
				project_id: PROJECT,
				targets
			})
		).id;
		await createRoutingRule(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, {
			project_id: 'prj_other',
			targets
		});

		expect(
			routingRulesForProject(await listRoutingRules(t.db, USER), PROJECT).map((rule) => rule.id)
		).toEqual([matching, global]);
	});
});
