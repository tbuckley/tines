import { describe, expect, it } from 'vitest';
import type { DispatchExplainer, QueueVerdict } from '@tines/shared';
import { createTestDb, type TestDb } from './test-db';
import { loadFleetQueue } from './supervisor';
import { explainDispatch } from '$lib/server/supervisor/explain';
import { queueVerdict } from '$lib/server/supervisor/logic';
import {
	addIssue,
	addLabel,
	addRule,
	addRun,
	addRunner,
	addTwoStageWorkflow,
	NOW,
	OPEN,
	PROJECT,
	REVIEW,
	seedBase,
	setSettings,
	STAGE_A,
	USER
} from '$lib/server/supervisor/test-fixtures';

const HOUR = 60 * 60 * 1000;

/**
 * A pin the runner map cannot answer. Deleting a runner clears its pins
 * (runners.ts) and the column carries a foreign key, so the only way to reach
 * the explainer's "pinned to a removed runner" branch is a pin to a runner
 * outside the user's fleet — the defensive case both surfaces still report.
 */
function pinToForeignRunner(t: TestDb, issueId: string): void {
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
			default_tier, config, launch_failures, draining, created_at, updated_at)
			VALUES ('rnr_theirs', 'u2', 'local', 'theirs', 'active', 1, 30, 'balanced', '{}', 0, 0, ${NOW}, ${NOW});
		UPDATE issue SET pinned_runner_id = 'rnr_theirs' WHERE id = '${issueId}';
	`);
}

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	return t;
}

/** The single group a one-shape world produces. */
async function onlyGroup(t: TestDb) {
	const queue = await loadFleetQueue(t.db, USER, NOW);
	expect(queue.groups).toHaveLength(1);
	return queue.groups[0];
}

describe('loadFleetQueue', () => {
	it('groups issues waiting on an offline runner, with the oldest wait clock', async () => {
		const t = world();
		const runner = addRunner(t, { name: 'macbook', lastSeen: NOW - 10 * HOUR });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { stateEnteredAt: NOW - 2 * HOUR, updatedAt: NOW - 3 });
		addIssue(t, { stateEnteredAt: NOW - 5 * HOUR, updatedAt: NOW - 2 });
		addIssue(t, { stateEnteredAt: NOW - HOUR, updatedAt: NOW - 1 });

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.waiting).toBe(3);
		const group = queue.groups[0];
		expect(group.verdict).toBe('offline');
		expect(group.count).toBe(3);
		expect(group.runner_name).toBe('macbook');
		expect(group.state_name).toBe('Open');
		expect(group.workflow_name).toBe('Standard');
		expect(group.binding).toBeNull();
		expect(group.oldest_entered_at).toBe(NOW - 5 * HOUR);
		// Refs arrive in dispatch order (oldest `updated_at` first), each with
		// the queue position the explainer would report.
		expect(group.issues.map((i) => i.entered_at)).toEqual([
			NOW - 2 * HOUR,
			NOW - 5 * HOUR,
			NOW - HOUR
		]);
		expect(group.issues.map((i) => i.queue_position)).toEqual([0, 1, 2]);
		expect(group.issues[0].project_name).toBe('demo');
	});

	it('names max_concurrent as the binding limit when a runner is at capacity', async () => {
		const t = world();
		const runner = addRunner(t, { name: 'macbook', maxConcurrent: 1 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const busy = addIssue(t);
		addRun(t, { issueId: busy, runnerId: runner, status: 'assigned' });
		addIssue(t);

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('at_capacity');
		expect(group.count).toBe(1);
		expect(group.binding).toEqual({
			kind: 'max_concurrent',
			runner_id: runner,
			runner_name: 'macbook',
			current: 1,
			limit: 1
		});
	});

	it('names the global cap when the quota policy is what binds', async () => {
		const t = world();
		setSettings(t, { quota: { type: 'global_cap', limit: 1 } });
		const runner = addRunner(t, { name: 'macbook', maxConcurrent: 5 });
		addRule(t, { targets: [{ runner_id: runner }] });
		const busy = addIssue(t);
		addRun(t, { issueId: busy, runnerId: runner, status: 'assigned' });
		addIssue(t);

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('quota_exhausted');
		expect(group.binding).toEqual({ kind: 'global_cap', current: 1, limit: 1 });
	});

	it('names the roster row, and whether it is an override, under a state roster', async () => {
		const t = world();
		addTwoStageWorkflow(t);
		setSettings(t, {
			quota: { type: 'state_roster', default_limit: 2, overrides: { [STAGE_A]: 0 } }
		});
		const runner = addRunner(t, { maxConcurrent: 5 });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { workflow: 'wf_two', state: STAGE_A });

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('quota_exhausted');
		expect(group.binding).toEqual({
			kind: 'state_roster',
			state_id: STAGE_A,
			current: 0,
			limit: 0,
			overridden: true
		});
		expect(group.state_name).toBe('Stage A');
	});

	it('speaks for the ok target when any target would take the issue', async () => {
		const t = world();
		const offline = addRunner(t, { name: 'asleep', lastSeen: NOW - 10 * HOUR });
		const ready = addRunner(t, { name: 'ready' });
		addRule(t, { targets: [{ runner_id: offline }, { runner_id: ready }] });
		addIssue(t);

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('ok');
		expect(group.runner_name).toBe('ready');
	});

	it('reports the routing failures a target verdict cannot express', async () => {
		const t = world();
		const runner = addRunner(t);
		const withTargets = addRule(t, { state: OPEN, targets: [{ runner_id: runner }] });
		const empty = addRule(t, { project: PROJECT, state: OPEN, targets: [] });
		expect(withTargets).not.toBe(empty);
		// The project+state rule is the more specific match, and it has no targets.
		addIssue(t);
		const noRuleProject = 'prj_2';
		t.sqlite.exec(
			`INSERT INTO project (id, user_id, name, created_at, updated_at)
				VALUES ('${noRuleProject}', '${USER}', 'other', ${NOW}, ${NOW})`
		);

		const byVerdict = new Map(
			(await loadFleetQueue(t.db, USER, NOW)).groups.map((g) => [g.verdict, g])
		);
		expect(byVerdict.get('no_targets')?.rule_id).toBe(empty);
	});

	it('reports a tie between two label rules as ambiguous, naming both rules', async () => {
		const t = world();
		const runner = addRunner(t);
		const a = addLabel(t, 'docs');
		const b = addLabel(t, 'qa');
		const ruleA = addRule(t, { label: a, targets: [{ runner_id: runner }] });
		const ruleB = addRule(t, { label: b, targets: [{ runner_id: runner }] });
		addIssue(t, { labels: [a, b] });

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('ambiguous_rule');
		expect([...group.ambiguous_rule_ids].sort()).toEqual([ruleA, ruleB].sort());
		expect(group.rule_id).toBeNull();
	});

	it('reports a pin whose runner was deleted as pin_missing', async () => {
		const t = world();
		const issue = addIssue(t);
		pinToForeignRunner(t, issue);

		const group = await onlyGroup(t);
		expect(group.verdict).toBe('pin_missing');
		expect(group.runner_id).toBeNull();
	});

	it('reports every eligible issue as automation_off when the kill switch is off', async () => {
		const t = world();
		setSettings(t, { enabled: false });
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);
		addIssue(t);

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.automation_enabled).toBe(false);
		expect(queue.groups.map((g) => g.verdict)).toEqual(['automation_off']);
		expect(queue.groups[0].count).toBe(2);
	});

	it('keeps parked issues out of the groups and in their own bucket', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { needsAttention: true, stateEnteredAt: NOW - 9 * HOUR, title: 'stuck' });
		addIssue(t, { needsAttention: true, stateEnteredAt: NOW - 2 * HOUR });

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.groups).toHaveLength(0);
		expect(queue.waiting).toBe(0);
		expect(queue.parked.count).toBe(2);
		expect(queue.parked.oldest_entered_at).toBe(NOW - 9 * HOUR);
		expect(queue.parked.issues[0].title).toBe('stuck');
	});

	it('summarises the human stages without listing them', async () => {
		const t = world();
		addIssue(t, { state: REVIEW, stateEnteredAt: NOW - 40 * HOUR });
		addIssue(t, { state: REVIEW, stateEnteredAt: NOW - HOUR });

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.awaiting_human).toEqual({ count: 2, oldest_entered_at: NOW - 40 * HOUR });
		expect(queue.groups).toHaveLength(0);
	});

	it('excludes archived projects, blocked issues and duplicates', async () => {
		const t = world();
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		const blocker = addIssue(t, { id: 'iss_blocker' });
		const blocked = addIssue(t, { id: 'iss_blocked' });
		const dup = addIssue(t, { id: 'iss_dup' });
		const target = addIssue(t, { id: 'iss_target' });
		t.sqlite.exec(`
			INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at)
				VALUES ('lnk_1', '${blocker}', '${blocked}', 'blocks', ${NOW}),
				       ('lnk_2', '${dup}', '${target}', 'duplicate_of', ${NOW});
			INSERT INTO project (id, user_id, name, archived_at, created_at, updated_at)
				VALUES ('prj_arch', '${USER}', 'archived', ${NOW}, ${NOW}, ${NOW});
		`);
		addIssue(t, { id: 'iss_arch', project: 'prj_arch' });

		const queue = await loadFleetQueue(t.db, USER, NOW);
		const ids = queue.groups.flatMap((g) => g.issues.map((i) => i.id));
		expect(ids).toContain(blocker);
		expect(ids).toContain(target);
		expect(ids).not.toContain(blocked);
		expect(ids).not.toContain(dup);
		expect(ids).not.toContain('iss_arch');
	});

	it('sorts the biggest group first, then the longest wait', async () => {
		const t = world();
		addTwoStageWorkflow(t);
		const runner = addRunner(t, { lastSeen: NOW - 10 * HOUR });
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t, { workflow: 'wf_two', state: STAGE_A, stateEnteredAt: NOW - 20 * HOUR });
		addIssue(t);
		addIssue(t);

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.groups.map((g) => [g.state_name, g.count])).toEqual([
			['Open', 2],
			['Stage A', 1]
		]);
	});
});

/** The queue's grouping inputs, read back off a per-issue explainer. */
function fromExplainer(explainer: DispatchExplainer, enabled: boolean): QueueVerdict {
	return queueVerdict({
		enabled,
		parked: explainer.parked,
		pinned: explainer.pin !== null,
		hasRule: explainer.matched_rule !== null,
		ambiguous: explainer.ambiguous_rules.length > 0,
		targets: explainer.targets
	});
}

describe('the fleet queue and the per-issue explainer agree', () => {
	// Acceptance criterion 5: for every issue in a group, the group's verdict
	// is the one `explainDispatch` reports for that issue — checked over a
	// world holding every verdict at once, so the two can never drift apart.
	it('on every issue of a mixed world', async () => {
		const t = world();
		addTwoStageWorkflow(t);
		const offline = addRunner(t, { name: 'asleep', lastSeen: NOW - 10 * HOUR });
		const full = addRunner(t, { name: 'full', maxConcurrent: 1 });
		const paused = addRunner(t, { name: 'paused', status: 'paused' });
		const docs = addLabel(t, 'docs');
		const qa = addLabel(t, 'qa');

		addRule(t, { state: OPEN, targets: [{ runner_id: offline }] });
		addRule(t, { state: STAGE_A, targets: [{ runner_id: full }] });
		addRule(t, { label: docs, targets: [{ runner_id: paused }] });
		addRule(t, { label: qa, targets: [{ runner_id: paused }] });

		const busy = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		addRun(t, { issueId: busy, runnerId: full, status: 'assigned' });
		addIssue(t, { stateEnteredAt: NOW - 3 * HOUR });
		addIssue(t, { workflow: 'wf_two', state: STAGE_A });
		addIssue(t, { labels: [docs, qa] });
		pinToForeignRunner(t, addIssue(t, { id: 'iss_pinned' }));
		addIssue(t, { needsAttention: true });

		const queue = await loadFleetQueue(t.db, USER, NOW);
		expect(queue.groups.length).toBeGreaterThan(2);
		let checked = 0;
		for (const group of queue.groups) {
			for (const ref of group.issues) {
				const explainer = await explainDispatch(t.db, USER, ref.id, NOW);
				expect(explainer, ref.id).not.toBeNull();
				expect(fromExplainer(explainer!, queue.automation_enabled), ref.id).toBe(group.verdict);
				expect(explainer!.queue_position, ref.id).toBe(ref.queue_position);
				checked++;
			}
		}
		expect(checked).toBe(queue.waiting);
	});

	it('including when the kill switch is off', async () => {
		const t = world();
		setSettings(t, { enabled: false });
		const runner = addRunner(t);
		addRule(t, { targets: [{ runner_id: runner }] });
		addIssue(t);

		const queue = await loadFleetQueue(t.db, USER, NOW);
		const ref = queue.groups[0].issues[0];
		const explainer = await explainDispatch(t.db, USER, ref.id, NOW);
		expect(fromExplainer(explainer!, queue.automation_enabled)).toBe(queue.groups[0].verdict);
	});
});
