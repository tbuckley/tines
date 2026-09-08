import { describe, expect, it } from 'vitest';
import {
	rateLimitHoldUntil,
	RATE_LIMIT_HOLD_DEFAULT_MS,
	RATE_LIMIT_HOLD_GRACE_MS,
	RATE_LIMIT_HOLD_MAX_MS,
	launchBackoffMs,
	matchRule,
	resolveRule,
	isRoutedCandidate,
	queueVerdict,
	speakingTarget,
	quotaHasRoom,
	resolveTier,
	targetVerdict,
	type ActiveCounts,
	type VerdictRunner
} from './logic';

const NOW = 1_723_000_000_000;

describe('matchRule', () => {
	const rules = [
		{ id: 'global', project_id: null, workflow_state_id: null, label_id: null, targets: [] },
		{ id: 'state', project_id: null, workflow_state_id: 's1', label_id: null, targets: [] },
		{ id: 'project', project_id: 'p1', workflow_state_id: null, label_id: null, targets: [] },
		{ id: 'both', project_id: 'p1', workflow_state_id: 's1', label_id: null, targets: [] }
	];
	/** An issue carrying no labels — the shape every pre-label rule sees. */
	const at = (project_id: string, state_id: string, label_ids: string[] = []) => ({
		project_id,
		state_id,
		label_ids
	});

	it('picks the most specific match: project ∧ state > project > state > global', () => {
		expect(matchRule(at('p1', 's1'), rules)?.id).toBe('both');
		expect(matchRule(at('p1', 's2'), rules)?.id).toBe('project');
		expect(matchRule(at('p2', 's1'), rules)?.id).toBe('state');
		expect(matchRule(at('p2', 's2'), rules)?.id).toBe('global');
	});

	it('project beats state (routing is ownership-shaped, unlike context ordering)', () => {
		const projectVsState = rules.filter((r) => r.id === 'state' || r.id === 'project');
		expect(matchRule(at('p1', 's1'), projectVsState)?.id).toBe('project');
	});

	it('returns null when nothing matches', () => {
		const scoped = rules.filter((r) => r.id !== 'global');
		expect(matchRule(at('p9', 's9'), scoped)).toBeNull();
	});

	it('a label rule does not match an issue without the label', () => {
		const labelled = [{ ...rules[0], id: 'design', label_id: 'l_design' }];
		expect(matchRule(at('p1', 's1'), labelled)).toBeNull();
		expect(matchRule(at('p1', 's1', ['l_design']), labelled)?.id).toBe('design');
	});
});

describe('resolveRule', () => {
	const design = {
		id: 'design',
		project_id: null,
		workflow_state_id: null,
		label_id: 'l_design',
		targets: []
	};
	const security = { ...design, id: 'security', label_id: 'l_security' };
	const at = (label_ids: string[]) => ({ project_id: 'p1', state_id: 's1', label_ids });

	it('a bare label rule beats project ∧ state', () => {
		const both = {
			id: 'both',
			project_id: 'p1',
			workflow_state_id: 's1',
			label_id: null,
			targets: []
		};
		expect(resolveRule(at(['l_design']), [both, design]).rule?.id).toBe('design');
	});

	it('label ∧ state beats a bare label', () => {
		const designReview = { ...design, id: 'design_review', workflow_state_id: 's1' };
		expect(resolveRule(at(['l_design']), [design, designReview]).rule?.id).toBe('design_review');
	});

	it('two label rules an issue matches equally fail closed and name both', () => {
		const resolved = resolveRule(at(['l_design', 'l_security']), [design, security]);
		expect(resolved.rule).toBeNull();
		expect(resolved.ambiguous.map((r) => r.id).sort()).toEqual(['design', 'security']);
		// matchRule is the same resolution, so every existing caller skips the
		// issue rather than routing it on an arbitrary winner.
		expect(matchRule(at(['l_design', 'l_security']), [design, security])).toBeNull();
	});

	it('a tie is broken by any rule that is more specific', () => {
		const designHere = { ...design, id: 'design_here', project_id: 'p1' };
		const resolved = resolveRule(at(['l_design', 'l_security']), [design, security, designHere]);
		expect(resolved.rule?.id).toBe('design_here');
		expect(resolved.ambiguous).toEqual([]);
	});

	it('reports no ambiguity when nothing matches at all', () => {
		const resolved = resolveRule(at([]), [design, security]);
		expect(resolved.rule).toBeNull();
		expect(resolved.ambiguous).toEqual([]);
	});
});

describe('resolveTier', () => {
	const local = (config: object, extras: object = {}) => ({
		type: 'local',
		default_tier: 'balanced',
		tiers: null,
		config: JSON.stringify(config),
		...extras
	});

	it('falls back to the runner default tier, itself defaulting to balanced', () => {
		const runner = local({ harness: 'claude_code' }, { default_tier: 'cheapest' });
		expect(resolveTier(runner, null).tier).toBe('cheapest');
		expect(resolveTier(local({ harness: 'claude_code' }, { default_tier: '' }), null).tier).toBe(
			'balanced'
		);
	});

	it('an explicit tier wins over the default', () => {
		const runner = local({ harness: 'claude_code' }, { default_tier: 'cheapest' });
		expect(resolveTier(runner, 'smartest').tier).toBe('smartest');
	});

	it('resolves via the built-in table per type and harness', () => {
		const cc = resolveTier(local({ harness: 'claude_code' }), 'smartest');
		expect(cc.model).toMatch(/^claude-/);
		const managed = resolveTier(
			{ type: 'gemini_managed', default_tier: 'balanced', tiers: null, config: '{}' },
			'cheapest'
		);
		expect(managed.model).toMatch(/^gemini-/);
	});

	it('a custom harness has no model dimension: any tier, model unknown', () => {
		const resolved = resolveTier(
			local({ harness: 'custom', command: 'run {prompt_file}' }),
			'smartest'
		);
		expect(resolved).toEqual({ tier: 'smartest', model: null });
	});

	it('per-runner overrides freeze a tier to an exact model; unlisted tiers keep the built-ins', () => {
		const runner = {
			type: 'local',
			default_tier: 'balanced',
			tiers: JSON.stringify({ smartest: { model: 'my-exact-model' } }),
			config: JSON.stringify({ harness: 'claude_code' })
		};
		expect(resolveTier(runner, 'smartest').model).toBe('my-exact-model');
		expect(resolveTier(runner, 'balanced').model).toMatch(/^claude-/);
	});

	it('unreadable JSON columns degrade to the built-ins, never crash', () => {
		const runner = { type: 'local', default_tier: 'balanced', tiers: '{oops', config: '{broken' };
		// Broken config falls back to the claude_code harness's table.
		expect(resolveTier(runner, 'balanced').model).toMatch(/^claude-/);
	});
});

describe('launchBackoffMs', () => {
	it('doubles per consecutive failure, capped at one hour', () => {
		expect(launchBackoffMs(0)).toBe(0);
		expect(launchBackoffMs(1)).toBe(60_000);
		expect(launchBackoffMs(2)).toBe(120_000);
		expect(launchBackoffMs(3)).toBe(240_000);
		expect(launchBackoffMs(20)).toBe(60 * 60 * 1000);
	});
});

describe('rateLimitHoldUntil', () => {
	it('holds for the default when the provider gave no usable reset', () => {
		expect(rateLimitHoldUntil(null, NOW)).toBe(NOW + RATE_LIMIT_HOLD_DEFAULT_MS);
		expect(rateLimitHoldUntil(undefined, NOW)).toBe(NOW + RATE_LIMIT_HOLD_DEFAULT_MS);
	});

	it('treats a reset already in the past as unknown', () => {
		expect(rateLimitHoldUntil(NOW - 1, NOW)).toBe(NOW + RATE_LIMIT_HOLD_DEFAULT_MS);
		expect(rateLimitHoldUntil(NOW, NOW)).toBe(NOW + RATE_LIMIT_HOLD_DEFAULT_MS);
	});

	it('holds to the reported reset plus a grace', () => {
		expect(rateLimitHoldUntil(NOW + 3_600_000, NOW)).toBe(
			NOW + 3_600_000 + RATE_LIMIT_HOLD_GRACE_MS
		);
	});

	it('clamps a far-out reset so a weekly limit re-probes daily', () => {
		expect(rateLimitHoldUntil(NOW + 7 * 86_400_000, NOW)).toBe(NOW + RATE_LIMIT_HOLD_MAX_MS);
	});
});

describe('targetVerdict', () => {
	const runner = (over: Partial<VerdictRunner> = {}): VerdictRunner => ({
		id: 'rnr_1',
		type: 'local',
		status: 'active',
		max_concurrent: 2,
		last_seen_at: NOW,
		draining: 0,
		backoff_until: null,
		backoff_reason: null,
		...over
	});
	const counts = (over: Partial<ActiveCounts> = {}): ActiveCounts => ({
		total: 0,
		byRunner: new Map(),
		byStartState: new Map(),
		...over
	});
	const globalCap = { type: 'global_cap' as const, limit: 3 };

	it('ok when unpaused, online, under caps, quota has room', () => {
		expect(targetVerdict(runner(), counts(), globalCap, 's1', NOW).verdict).toBe('ok');
	});

	it('paused wins over everything else', () => {
		expect(
			targetVerdict(runner({ status: 'paused' }), counts(), globalCap, 's1', NOW).verdict
		).toBe('paused');
	});

	it('a local runner unseen for over 2 minutes is offline; managed runners never are', () => {
		expect(
			targetVerdict(runner({ last_seen_at: NOW - 3 * 60_000 }), counts(), globalCap, 's1', NOW)
				.verdict
		).toBe('offline');
		expect(
			targetVerdict(runner({ last_seen_at: null }), counts(), globalCap, 's1', NOW).verdict
		).toBe('offline');
		expect(
			targetVerdict(
				runner({ type: 'claude_managed', last_seen_at: null }),
				counts(),
				globalCap,
				's1',
				NOW
			).verdict
		).toBe('ok');
	});

	it('a draining local daemon takes nothing new; offline outranks it, and managed runners never drain', () => {
		expect(targetVerdict(runner({ draining: 1 }), counts(), globalCap, 's1', NOW).verdict).toBe(
			'draining'
		);
		expect(
			targetVerdict(
				runner({ draining: 1, last_seen_at: NOW - 3 * 60_000 }),
				counts(),
				globalCap,
				's1',
				NOW
			).verdict
		).toBe('offline');
		expect(
			targetVerdict(
				runner({ type: 'claude_managed', last_seen_at: null, draining: 1 }),
				counts(),
				globalCap,
				's1',
				NOW
			).verdict
		).toBe('ok');
	});

	it('backing off until the backoff expires', () => {
		expect(
			targetVerdict(runner({ backoff_until: NOW + 1 }), counts(), globalCap, 's1', NOW).verdict
		).toBe('backing_off');
		expect(
			targetVerdict(runner({ backoff_until: NOW }), counts(), globalCap, 's1', NOW).verdict
		).toBe('ok');
	});

	it('a usage-limit hold reads as rate limited, and says when it resumes', () => {
		const held = targetVerdict(
			runner({ backoff_until: NOW + 60_000, backoff_reason: 'rate_limit' }),
			counts(),
			globalCap,
			's1',
			NOW
		);
		expect(held.verdict).toBe('rate_limited');
		expect(held.detail).toContain(new Date(NOW + 60_000).toISOString());
		// Expired, and the failure backoff with the same window, are unchanged.
		expect(
			targetVerdict(
				runner({ backoff_until: NOW, backoff_reason: 'rate_limit' }),
				counts(),
				globalCap,
				's1',
				NOW
			).verdict
		).toBe('ok');
		expect(
			targetVerdict(runner({ backoff_until: NOW + 60_000 }), counts(), globalCap, 's1', NOW).verdict
		).toBe('backing_off');
	});

	it('at max_concurrent', () => {
		const c = counts({ byRunner: new Map([['rnr_1', 2]]), total: 2 });
		expect(targetVerdict(runner(), c, globalCap, 's1', NOW).verdict).toBe('at_capacity');
	});

	it('global cap exhaustion', () => {
		const c = counts({ total: 3 });
		expect(targetVerdict(runner(), c, globalCap, 's1', NOW).verdict).toBe('quota_exhausted');
	});

	it('roster counts per start state with overrides over the default', () => {
		const roster = { type: 'state_roster' as const, default_limit: 1, overrides: { s2: 2 } };
		const c = counts({
			total: 2,
			byStartState: new Map([
				['s1', 1],
				['s2', 1]
			])
		});
		expect(targetVerdict(runner(), c, roster, 's1', NOW).verdict).toBe('quota_exhausted');
		expect(targetVerdict(runner(), c, roster, 's2', NOW).verdict).toBe('ok');
	});
});

describe('quotaHasRoom', () => {
	it('a roster limit of zero means no agents work that stage', () => {
		const roster = { type: 'state_roster' as const, default_limit: 1, overrides: { s1: 0 } };
		const counts: ActiveCounts = { total: 0, byRunner: new Map(), byStartState: new Map() };
		expect(quotaHasRoom(roster, counts, 's1')).toBe(false);
		expect(quotaHasRoom(roster, counts, 's2')).toBe(true);
	});
});

describe('speakingTarget', () => {
	it('prefers the first ok target — where dispatch would actually send it', () => {
		const targets = [
			{ id: 'a', verdict: 'offline' as const },
			{ id: 'b', verdict: 'ok' as const },
			{ id: 'c', verdict: 'ok' as const }
		];
		expect(speakingTarget(targets)?.id).toBe('b');
	});

	it('falls back to the first target in preference order', () => {
		const targets = [
			{ id: 'a', verdict: 'at_capacity' as const },
			{ id: 'b', verdict: 'offline' as const }
		];
		expect(speakingTarget(targets)?.id).toBe('a');
	});

	it('is null for no targets', () => {
		expect(speakingTarget([])).toBeNull();
	});
});

describe('queueVerdict', () => {
	const base = {
		enabled: true,
		parked: false,
		pinned: false,
		hasRule: true,
		ambiguous: false,
		targets: [{ verdict: 'ok' as const }]
	};

	it('reports the kill switch above everything else', () => {
		expect(queueVerdict({ ...base, enabled: false, parked: true, targets: [] })).toBe(
			'automation_off'
		);
	});

	it('reports parked above the routing failures', () => {
		expect(queueVerdict({ ...base, parked: true, hasRule: false, targets: [] })).toBe('parked');
	});

	it('distinguishes the four ways an issue reaches no targets', () => {
		const none = { ...base, targets: [] };
		expect(queueVerdict({ ...none, pinned: true })).toBe('pin_missing');
		expect(queueVerdict({ ...none, ambiguous: true, hasRule: false })).toBe('ambiguous_rule');
		expect(queueVerdict({ ...none, hasRule: true })).toBe('no_targets');
		expect(queueVerdict({ ...none, hasRule: false })).toBe('no_rule');
	});

	it('otherwise speaks for the speaking target', () => {
		expect(queueVerdict(base)).toBe('ok');
		expect(
			queueVerdict({ ...base, targets: [{ verdict: 'offline' }, { verdict: 'at_capacity' }] })
		).toBe('offline');
		expect(queueVerdict({ ...base, targets: [{ verdict: 'offline' }, { verdict: 'ok' }] })).toBe(
			'ok'
		);
	});
});

describe('isRoutedCandidate', () => {
	const rules = [
		{
			id: 'r1',
			project_id: 'p1',
			workflow_state_id: null,
			label_id: null,
			targets: [{ runner_id: 'rnr_1', tier: null }]
		},
		{ id: 'empty', project_id: 'p2', workflow_state_id: null, label_id: null, targets: [] },
		{
			id: 'lab_a',
			project_id: null,
			workflow_state_id: null,
			label_id: 'l_a',
			targets: [{ runner_id: 'rnr_1', tier: null }]
		},
		{
			id: 'lab_b',
			project_id: null,
			workflow_state_id: null,
			label_id: 'l_b',
			targets: [{ runner_id: 'rnr_2', tier: null }]
		}
	];
	const issue = (project_id: string, label_ids: string[] = [], pin: string | null = null) => ({
		project_id,
		state_id: 's1',
		label_ids,
		pinned_runner_id: pin
	});

	it('routes a pinned issue regardless of the rules', () => {
		expect(isRoutedCandidate(issue('p9', [], 'rnr_9'), rules)).toBe(true);
	});

	it('routes an issue whose winning rule has targets', () => {
		expect(isRoutedCandidate(issue('p1'), rules)).toBe(true);
	});

	it('excludes a rule with no targets, no rule at all, and a tie', () => {
		expect(isRoutedCandidate(issue('p2'), rules)).toBe(false);
		expect(isRoutedCandidate(issue('p9'), rules)).toBe(false);
		expect(isRoutedCandidate(issue('p9', ['l_a', 'l_b']), rules)).toBe(false);
	});
});
