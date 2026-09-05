import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../api/test-db';
import { runDispatchPass } from './engine';
import { loadIssue } from '../api/issues';
import { explainDispatch } from './explain';
import { createFakeAdapter } from './fake-adapter';
import {
	addIssue,
	addLabel,
	addRule,
	addRunner,
	NOW,
	OPEN,
	PROJECT,
	REVIEW,
	seedBase,
	setSettings,
	USER
} from './test-fixtures';

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	return t;
}

function check(explainer: NonNullable<Awaited<ReturnType<typeof explainDispatch>>>, name: string) {
	const found = explainer.checks.find((c) => c.name === name);
	expect(found, `check ${name}`).toBeDefined();
	return found!;
}

describe('explainDispatch', () => {
	it('returns null for an unknown issue (cross-user 404 at the route)', async () => {
		const t = world();
		expect(await explainDispatch(t.db, USER, 'iss_nope', NOW)).toBeNull();
	});

	it('leads with the kill switch when automation is off', async () => {
		const t = world();
		setSettings(t, { enabled: false });
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.verdict).toBe('Automation is off');
		expect(ex.eligible).toBe(false);
		expect(check(ex, 'automation_enabled').ok).toBe(false);
	});

	it('names the ineligible state and category', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { state: REVIEW });
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.verdict).toBe('Not eligible — state Human Review (awaiting_human)');
		expect(check(ex, 'state_active').ok).toBe(false);
	});

	it('explains blockers and duplicates as not-ready', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		const blocker = addIssue(t);
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES ('lnk_1', ?, ?, 'blocks', ${NOW})`
			)
			.run(blocker, issue);
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(check(ex, 'ready').ok).toBe(false);
		expect(ex.verdict).toContain('Not eligible — blocked by');
	});

	it('reports parking with the attempt tally', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { needsAttention: true, attemptCount: 3 });
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.parked).toBe(true);
		expect(ex.attempt_count).toBe(3);
		expect(ex.attempt_limit).toBe(3);
		expect(ex.verdict).toBe('Parked — agents struck out 3 times here');
	});

	it('says so when no rule matches', async () => {
		const t = world();
		addRunner(t);
		const issue = addIssue(t);
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.matched_rule).toBeNull();
		expect(check(ex, 'routed').ok).toBe(false);
		expect(ex.verdict).toBe('No matching routing rule — nothing will dispatch');
	});

	it('names the matched rule and per-target verdicts with tier→model resolution', async () => {
		const t = world();
		const paused = addRunner(t, { status: 'paused', defaultTier: 'smartest' });
		const offline = addRunner(t, { lastSeen: NOW - 10 * 60_000 });
		addRule(t, { targets: [{ runner_id: paused }, { runner_id: offline, tier: 'cheapest' }] });
		const issue = addIssue(t);

		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.eligible).toBe(true);
		expect(ex.matched_rule!.scope_label).toBe('global');
		expect(ex.targets).toHaveLength(2);
		expect(ex.targets[0]).toMatchObject({ verdict: 'paused', tier: 'smartest' });
		expect(ex.targets[0].model).toMatch(/^claude-/);
		expect(ex.targets[1]).toMatchObject({ verdict: 'offline', tier: 'cheapest' });
		expect(ex.verdict).toContain('is paused');
	});

	it('labels a scoped rule with the project and state names', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { project: PROJECT, state: OPEN, targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.matched_rule!.scope_label).toBe('project demo · state Open');
	});

	it("names the label in a label-scoped rule's scope", async () => {
		const t = world();
		const runner = addRunner(t);
		const docs = addLabel(t, 'docs');
		addRule(t, { project: PROJECT, label: docs, targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { labels: [docs] });
		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.matched_rule!.scope_label).toBe('project demo · label docs');
		expect(ex.ambiguous_rules).toEqual([]);
		expect(check(ex, 'routed').ok).toBe(true);
	});

	it('names both rules, and refuses to route, when two label rules tie', async () => {
		const t = world();
		const runner = addRunner(t);
		const docs = addLabel(t, 'docs');
		const security = addLabel(t, 'security');
		addRule(t, { label: docs, targets: [{ runner_id: runner }] });
		addRule(t, { label: security, targets: [{ runner_id: runner }] });
		const issue = addIssue(t, { labels: [docs, security] });

		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.matched_rule).toBeNull();
		expect(ex.ambiguous_rules.map((r) => r.scope_label).sort()).toEqual([
			'label docs',
			'label security'
		]);
		expect(ex.eligible).toBe(false);
		expect(check(ex, 'routed').ok).toBe(false);
		expect(check(ex, 'routed').detail).toContain('neither is more specific');
		expect(ex.verdict).toBe('Two routing rules tie — make one more specific');
	});

	it('shows the pin (replacing rules) even when a rule would match', async () => {
		const t = world();
		const ruled = addRunner(t);
		const pinned = addRunner(t, { status: 'paused' });
		addRule(t, { targets: [{ runner_id: ruled }] });
		const issue = addIssue(t, { pinnedRunner: pinned, pinnedTier: 'cheapest' });

		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.pin).toMatchObject({ runner_id: pinned, tier: 'cheapest' });
		expect(ex.matched_rule).toBeNull();
		expect(ex.targets).toHaveLength(1);
		expect(ex.targets[0].verdict).toBe('paused');
		expect(check(ex, 'routed').detail).toContain('pinned to');
	});

	it('reports the active run instead of a queue verdict', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const issue = addIssue(t);
		await runDispatchPass(t.db, t.env, USER, {
			now: NOW,
			adapters: { local: createFakeAdapter() }
		});

		const ex = (await explainDispatch(t.db, USER, issue, NOW))!;
		expect(ex.active_run).not.toBeNull();
		expect(ex.active_run!.status).toBe('running');
		expect(check(ex, 'no_active_run').ok).toBe(false);
		expect(ex.verdict).toContain('is working this issue');
	});

	it('gives eligible-but-waiting issues their queue position', async () => {
		const t = world();
		setSettings(t, { quota: { type: 'global_cap', limit: 1 } });
		const runner = addRunner(t, { maxConcurrent: 10 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const busy = addIssue(t, { updatedAt: NOW - 3000 });
		addIssue(t, { updatedAt: NOW - 2000 });
		const waiting = addIssue(t, { updatedAt: NOW - 1000 });
		// The cap is consumed by the oldest issue's run.
		await runDispatchPass(t.db, t.env, USER, {
			now: NOW,
			adapters: { local: createFakeAdapter() }
		});

		const ex = (await explainDispatch(t.db, USER, waiting, NOW))!;
		expect(ex.eligible).toBe(true);
		expect(ex.targets[0].verdict).toBe('quota_exhausted');
		// One eligible issue (the middle one) is ahead; the busy one is out of
		// the pool while its run holds the claim.
		expect(ex.queue_position).toBe(1);
		expect(ex.verdict).toBe(
			`Eligible — waiting for capacity on ${runner} (1 eligible issue ahead)`
		);

		const exBusy = (await explainDispatch(t.db, USER, busy, NOW))!;
		expect(exBusy.queue_position).toBeNull();
	});
});

// The issue page already has the issue row (Tines/32); handing it over saves a
// re-read of the most expensive query on the page.
describe('explainDispatch with a preloaded issue', () => {
	it('matches the self-fetching path without re-reading the row', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const id = addIssue(t, { updatedAt: NOW - 1000 });

		const fetched = await explainDispatch(t.db, USER, id, NOW);
		const issue = await loadIssue(t.db, USER, { id });

		const spy = t.spyOnQueries();
		const preloaded = await explainDispatch(t.db, USER, id, NOW, issue);
		expect(preloaded).toEqual(fetched);
		expect(spy().some((sql) => sql.includes('dup_chain'))).toBe(false);
	});
});
