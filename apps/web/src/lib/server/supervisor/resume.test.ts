import { describe, expect, it } from 'vitest';
import { createTestDb } from '../api/test-db';
import { addIssue, addRun, addRunner, NOW, seedBase, USER } from './test-fixtures';
import {
	claimResourceDisposal,
	claimResumeResource,
	disposeExpiredResumeResources,
	isResumeProviderSupported,
	orderTargetsByResumeAffinity,
	resumeAffinityByIssue,
	resumeEligibility
} from './resume';

const insertResource = (
	t: ReturnType<typeof createTestDb>,
	values: {
		id: string;
		runnerId: string;
		issueId: string;
		ownerRunId: string;
		state?: string;
		expiresAt: number;
		session?: string;
	}
) =>
	t.sqlite
		.prepare(
			`INSERT INTO run_resource (
			id, user_id, runner_id, issue_id, kind, owner_run_id, state, expires_at,
			provider_session_id, resume_fingerprint, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'local_claude', ?, ?, ?, ?, 'v1:abc', ?, ?)`
		)
		.run(
			values.id,
			USER,
			values.runnerId,
			values.issueId,
			values.ownerRunId,
			values.state ?? 'available',
			values.expiresAt,
			values.session ?? values.id,
			NOW,
			NOW
		);

const runner = {
	id: 'rnr_1',
	type: 'local' as const,
	config: { harness: 'claude_code' },
	resume_enabled: true,
	resume_window_hours: 48,
	resume_max_turns: 25,
	resume_max_tokens: 100_000,
	resume_max_cost_usd: 2
};

const base = {
	now: NOW,
	runner,
	predecessor: {
		id: 'run_old',
		runner_id: runner.id,
		ended_at: NOW - 1000,
		outcome: 'advanced',
		conversation_turn_count: 24
	},
	conversation_usage: null,
	resource: {
		kind: 'local_claude' as const,
		runner_id: runner.id,
		owner_run_id: 'run_old',
		state: 'available' as const,
		expires_at: NOW + 1000,
		resume_fingerprint: 'v1:abc'
	},
	newest_ended_run_id: 'run_old',
	ended_in_awaiting_state: true,
	last_transition_authored_by_run: true,
	expected_fingerprint: 'v1:abc'
};

describe('resumeEligibility', () => {
	const supported = () => true;

	// Tines/362 opened the local Claude Code gate: `claude -p --resume` in the
	// kept workspace is the shipped path. Managed reuse stays closed until the
	// credential ownership transfer exists, so enabling it is still rejected.
	it('opens the local Claude Code gate and keeps the managed one closed', () => {
		expect(isResumeProviderSupported('local', { harness: 'claude_code' })).toBe(true);
		expect(isResumeProviderSupported('local', {})).toBe(true);
		expect(isResumeProviderSupported('local', { harness: 'codex' })).toBe(false);
		expect(isResumeProviderSupported('local', { harness: 'custom' })).toBe(false);
		expect(isResumeProviderSupported('claude_managed', {})).toBe(false);
	});

	it('keeps continuation off when the provider is supported but the runner has not opted in', () => {
		expect(
			resumeEligibility({ ...base, runner: { ...runner, resume_enabled: false } }, () => true)
		).toEqual({ eligible: false, reason: 'unsupported' });
	});

	it('accepts a local conversation strictly below the turn threshold', () => {
		expect(resumeEligibility(base, supported)).toEqual({ eligible: true });
		expect(
			resumeEligibility(
				{
					...base,
					predecessor: { ...base.predecessor, conversation_turn_count: 25 }
				},
				supported
			)
		).toEqual({ eligible: false, reason: 'long_context' });
	});

	it('uses the shorter of retained and current-policy expiry and rejects drift/newer attempts', () => {
		expect(resumeEligibility({ ...base, now: NOW + 1000 }, supported)).toEqual({
			eligible: false,
			reason: 'expired'
		});
		expect(resumeEligibility({ ...base, expected_fingerprint: 'v1:new' }, supported)).toEqual({
			eligible: false,
			reason: 'incompatible'
		});
		expect(resumeEligibility({ ...base, newest_ended_run_id: 'run_newer' }, supported)).toEqual({
			eligible: false,
			reason: 'unavailable'
		});
	});

	it('requires complete managed cumulative usage and strict token/cost bounds', () => {
		const managed = {
			...base,
			runner: { ...runner, type: 'claude_managed' as const, config: {} },
			resource: { ...base.resource, kind: 'claude_managed' as const },
			conversation_usage: {
				input_tokens: 40,
				output_tokens: 20,
				cache_read_tokens: 30,
				cache_write_tokens: 9,
				cost_usd: 1
			}
		};
		expect(resumeEligibility(managed, supported)).toEqual({ eligible: true });
		expect(
			resumeEligibility(
				{ ...managed, runner: { ...managed.runner, resume_max_tokens: 99 } },
				supported
			)
		).toEqual({ eligible: false, reason: 'long_context' });
		expect(
			resumeEligibility(
				{
					...managed,
					conversation_usage: { input_tokens: 1, output_tokens: 1, cost_usd: 1 }
				},
				supported
			)
		).toEqual({ eligible: false, reason: 'unavailable' });
	});
});

describe('resource claims', () => {
	it('allows exactly one of resume and disposal to win', async () => {
		const t = createTestDb();
		seedBase(t);
		const runnerId = addRunner(t);
		const issueId = addIssue(t);
		addRun(t, { id: 'run_old', issueId, runnerId, createdAt: NOW - 1 });
		addRun(t, { id: 'run_new', issueId, runnerId, createdAt: NOW });
		t.sqlite
			.prepare(
				`INSERT INTO run_resource (
			id, user_id, runner_id, issue_id, kind, owner_run_id, state, expires_at,
			provider_session_id, resume_fingerprint, created_at, updated_at
		) VALUES ('res_1', ?, ?, ?, 'local_claude', 'run_old', 'available', ?, 'session_1', 'v1:abc', ?, ?)`
			)
			.run(USER, runnerId, issueId, NOW + 1000, NOW, NOW);

		expect(
			await claimResumeResource(t.db, {
				resourceId: 'res_1',
				ownerRunId: 'run_old',
				claimRunId: 'run_new',
				claimToken: 'token',
				now: NOW
			})
		).toBe(true);
		expect(await claimResourceDisposal(t.db, 'res_1', NOW)).toBe(false);
		expect(t.all(`SELECT state, claim_run_id, transfer_phase FROM run_resource`)).toEqual([
			{ state: 'claimed', claim_run_id: 'run_new', transfer_phase: 'preparing' }
		]);
	});
});

describe('dispatch affinity', () => {
	it('only reorders targets, and only for a live available resource', async () => {
		const t = createTestDb();
		seedBase(t);
		const runnerId = addRunner(t);
		const issueId = addIssue(t);
		addRun(t, { id: 'run_old', issueId, runnerId, createdAt: NOW - 1 });
		insertResource(t, {
			id: 'res_live',
			runnerId,
			issueId,
			ownerRunId: 'run_old',
			expiresAt: NOW + 1000
		});

		const affinity = await resumeAffinityByIssue(t.db, USER, [issueId], NOW);
		expect(affinity.get(issueId)).toEqual(new Set([runnerId]));

		const targets = [{ runner_id: 'rnr_other' }, { runner_id: runnerId }];
		expect(orderTargetsByResumeAffinity(targets, affinity.get(issueId))).toEqual([
			{ runner_id: runnerId },
			{ runner_id: 'rnr_other' }
		]);
		// Never adds, drops or reorders when there is nothing to prefer.
		expect(orderTargetsByResumeAffinity(targets, new Set(['rnr_absent']))).toBe(targets);
		expect(orderTargetsByResumeAffinity(targets, undefined)).toBe(targets);
	});

	it('ignores expired and claimed resources', async () => {
		const t = createTestDb();
		seedBase(t);
		const runnerId = addRunner(t);
		const issueId = addIssue(t);
		addRun(t, { id: 'run_old', issueId, runnerId, createdAt: NOW - 1 });
		insertResource(t, { id: 'res_exp', runnerId, issueId, ownerRunId: 'run_old', expiresAt: NOW });
		insertResource(t, {
			id: 'res_claimed',
			runnerId,
			issueId,
			ownerRunId: 'run_old',
			state: 'claimed',
			expiresAt: NOW + 1000
		});
		expect(await resumeAffinityByIssue(t.db, USER, [issueId], NOW)).toEqual(new Map());
		expect(await resumeAffinityByIssue(t.db, USER, [], NOW)).toEqual(new Map());
	});
});

describe('expired resource disposal', () => {
	it('disposes expired available rows and leaves live and claimed ones', async () => {
		const t = createTestDb();
		seedBase(t);
		const runnerId = addRunner(t);
		const issueId = addIssue(t);
		addRun(t, { id: 'run_old', issueId, runnerId, createdAt: NOW - 1 });
		insertResource(t, {
			id: 'res_exp',
			runnerId,
			issueId,
			ownerRunId: 'run_old',
			expiresAt: NOW - 1
		});
		insertResource(t, {
			id: 'res_live',
			runnerId,
			issueId,
			ownerRunId: 'run_old',
			expiresAt: NOW + 1000
		});
		insertResource(t, {
			id: 'res_claimed',
			runnerId,
			issueId,
			ownerRunId: 'run_old',
			state: 'claimed',
			expiresAt: NOW - 1
		});

		expect(await disposeExpiredResumeResources(t.db, NOW)).toBe(1);
		expect(t.all(`SELECT id FROM run_resource ORDER BY id`)).toEqual([
			{ id: 'res_claimed' },
			{ id: 'res_live' }
		]);
		expect(await disposeExpiredResumeResources(t.db, NOW)).toBe(0);
	});
});
