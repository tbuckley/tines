/**
 * Seed helpers for the supervisor unit tests, over the real test-db harness
 * (actual migrations, foreign keys ON). Test-only: nothing in the app
 * imports this module.
 */
import type { ModelTier, QuotaPolicy, RoutingTarget } from '@tines/shared';
import type { TestDb } from '../api/test-db';

export const NOW = 1_723_000_000_000;
export const USER = 'u1';
export const PROJECT = 'prj_1';
/** The standard workflow's states (seeded by migration 0002). */
export const OPEN = 'wfs_std_open'; // active
export const REVIEW = 'wfs_std_review'; // awaiting_human
export const CLOSED = 'wfs_std_closed'; // done

export function seedBase(t: TestDb): void {
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('${USER}', 'alice', 'a@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('${PROJECT}', '${USER}', 'demo', ${NOW}, ${NOW});
	`);
}

export function setSettings(
	t: TestDb,
	opts: { enabled?: boolean; quota?: QuotaPolicy; attemptLimit?: number } = {}
): void {
	const quota = opts.quota ?? { type: 'global_cap', limit: 3 };
	t.sqlite
		.prepare(
			`INSERT INTO supervisor_settings (user_id, enabled, quota, attempt_limit, updated_at)
			VALUES (?, ?, ?, ?, ${NOW})
			ON CONFLICT(user_id) DO UPDATE SET
				enabled = excluded.enabled, quota = excluded.quota, attempt_limit = excluded.attempt_limit`
		)
		.run(USER, opts.enabled === false ? 0 : 1, JSON.stringify(quota), opts.attemptLimit ?? 3);
}

let issueSeq = 0;

export function addIssue(
	t: TestDb,
	opts: {
		id?: string;
		state?: string;
		workflow?: string;
		project?: string;
		updatedAt?: number;
		pinnedRunner?: string;
		pinnedTier?: ModelTier;
		attemptCount?: number;
		needsAttention?: boolean;
	} = {}
): string {
	const id = opts.id ?? `iss_${++issueSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO issue (id, project_id, number, title, workflow_id, state_id,
				pinned_runner_id, pinned_tier, attempt_count, needs_attention, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			opts.project ?? PROJECT,
			++issueSeq,
			`Issue ${id}`,
			opts.workflow ?? 'wf_standard',
			opts.state ?? OPEN,
			opts.pinnedRunner ?? null,
			opts.pinnedTier ?? null,
			opts.attemptCount ?? 0,
			opts.needsAttention ? 1 : 0,
			NOW,
			opts.updatedAt ?? NOW
		);
	return id;
}

let runnerSeq = 0;

export function addRunner(
	t: TestDb,
	opts: {
		id?: string;
		name?: string;
		type?: string;
		status?: string;
		maxConcurrent?: number;
		maxRunMinutes?: number;
		defaultTier?: ModelTier;
		tiers?: Record<string, { model: string } | string>;
		harness?: string;
		lastSeen?: number | null;
		launchFailures?: number;
		backoffUntil?: number | null;
	} = {}
): string {
	const id = opts.id ?? `rnr_${++runnerSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
				default_tier, tiers, config, last_seen_at, launch_failures, backoff_until, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			USER,
			opts.type ?? 'local',
			opts.name ?? id,
			opts.status ?? 'active',
			opts.maxConcurrent ?? 1,
			opts.maxRunMinutes ?? 30,
			opts.defaultTier ?? 'balanced',
			opts.tiers ? JSON.stringify(opts.tiers) : null,
			JSON.stringify({ harness: opts.harness ?? 'claude_code' }),
			opts.lastSeen === undefined ? NOW : opts.lastSeen,
			opts.launchFailures ?? 0,
			opts.backoffUntil ?? null,
			NOW,
			NOW
		);
	return id;
}

let ruleSeq = 0;

export function addRule(
	t: TestDb,
	opts: { id?: string; project?: string | null; state?: string | null; targets: RoutingTarget[] }
): string {
	const id = opts.id ?? `rul_${++ruleSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO routing_rule (id, user_id, project_id, workflow_state_id, targets, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, USER, opts.project ?? null, opts.state ?? null, JSON.stringify(opts.targets), NOW, NOW);
	return id;
}

/**
 * A second workflow with two `active` stages, for roster tests (the standard
 * workflow has only one).
 */
export const STAGE_A = 'wfs_two_a';
export const STAGE_B = 'wfs_two_b';

export function addTwoStageWorkflow(t: TestDb): void {
	t.sqlite.exec(`
		INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_two', '${USER}', 'Two stages', '${STAGE_A}', ${NOW}, ${NOW});
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
			('${STAGE_A}', 'wf_two', 'Stage A', 'active', 0, ${NOW}),
			('${STAGE_B}', 'wf_two', 'Stage B', 'active', 1, ${NOW}),
			('wfs_two_done', 'wf_two', 'Done', 'done', 2, ${NOW});
	`);
}

let runSeq = 0;

/** A raw agent_run row, for protocol/lifecycle scenarios that start mid-flight. */
export function addRun(
	t: TestDb,
	opts: {
		id?: string;
		issueId: string;
		runnerId: string;
		status?: string;
		tier?: ModelTier;
		model?: string | null;
		stateAtStart?: string;
		apiKeyId?: string | null;
		createdAt?: number;
		startedAt?: number | null;
		log?: string;
		logBytesDropped?: number;
	}
): string {
	const id = opts.id ?? `arun_${++runSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, model,
				state_id_at_start, api_key_id, log, log_bytes_dropped, created_at, started_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			USER,
			opts.issueId,
			opts.runnerId,
			opts.status ?? 'assigned',
			opts.tier ?? 'balanced',
			opts.model === undefined ? 'claude-sonnet-5' : opts.model,
			opts.stateAtStart ?? OPEN,
			opts.apiKeyId ?? null,
			opts.log ?? '',
			opts.logBytesDropped ?? 0,
			opts.createdAt ?? NOW,
			opts.startedAt ?? null
		);
	return id;
}

/** A raw issue.transitioned event, for end-judgment scenarios. */
export function addTransitionEvent(
	t: TestDb,
	opts: {
		issueId: string;
		apiKeyId: string | null;
		at: number;
		from?: string;
		to?: string;
	}
): void {
	t.sqlite
		.prepare(
			`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
			VALUES (?, ?, 'issue.transitioned', ?, ?, ?, ?, ?, ?)`
		)
		.run(
			`evt_${Math.random().toString(36).slice(2)}`,
			USER,
			USER,
			opts.apiKeyId,
			opts.issueId,
			PROJECT,
			JSON.stringify({ from_state_id: opts.from ?? OPEN, to_state_id: opts.to ?? REVIEW }),
			opts.at
		);
}

// -- assertion helpers --------------------------------------------------------

export function runs(t: TestDb): Record<string, unknown>[] {
	return t.all('SELECT * FROM agent_run ORDER BY created_at, id');
}

export function runById(t: TestDb, id: string): Record<string, unknown> | undefined {
	return t.all('SELECT * FROM agent_run WHERE id = ?', id)[0];
}

export function issueById(t: TestDb, id: string): Record<string, unknown> {
	return t.all('SELECT * FROM issue WHERE id = ?', id)[0];
}

export function runnerById(t: TestDb, id: string): Record<string, unknown> {
	return t.all('SELECT * FROM runner WHERE id = ?', id)[0];
}

export function eventsOfType(
	t: TestDb,
	type: string
): (Record<string, unknown> & { payload: Record<string, unknown> })[] {
	return t.all('SELECT * FROM event WHERE type = ? ORDER BY created_at, id', type).map((e) => ({
		...e,
		payload: JSON.parse(e.payload as string) as Record<string, unknown>
	}));
}

export function keyForRun(t: TestDb, runId: string): Record<string, unknown> | undefined {
	return t.all('SELECT * FROM api_key WHERE agent_run_id = ?', runId)[0];
}
