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
		/** The wait clock the fleet queue reads; defaults to `created_at`. */
		stateEnteredAt?: number;
		pinnedRunner?: string;
		pinnedTier?: ModelTier;
		attemptCount?: number;
		needsAttention?: boolean;
		title?: string;
		description?: string;
		labels?: string[];
	} = {}
): string {
	const id = opts.id ?? `iss_${++issueSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id,
				pinned_runner_id, pinned_tier, attempt_count, needs_attention, created_at, updated_at,
				state_entered_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			opts.project ?? PROJECT,
			++issueSeq,
			opts.title ?? `Issue ${id}`,
			opts.description ?? '',
			opts.workflow ?? 'wf_standard',
			opts.state ?? OPEN,
			opts.pinnedRunner ?? null,
			opts.pinnedTier ?? null,
			opts.attemptCount ?? 0,
			opts.needsAttention ? 1 : 0,
			NOW,
			opts.updatedAt ?? NOW,
			opts.stateEnteredAt ?? NOW
		);
	for (const labelId of opts.labels ?? []) {
		t.sqlite
			.prepare(`INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)`)
			.run(id, labelId, NOW);
	}
	return id;
}

let labelSeq = 0;

/** An issue label, the fourth scope dimension a rule can carry. */
export function addLabel(t: TestDb, name: string, opts: { id?: string } = {}): string {
	const id = opts.id ?? `lab_${++labelSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO label (id, user_id, name, color, description, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, USER, name, 'slate', '', NOW, NOW);
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
		tiers?: Record<string, { model: string; effort?: string } | string>;
		budget?: Record<string, number>;
		harness?: string;
		config?: Record<string, unknown>;
		secretEnc?: string;
		lastSeen?: number | null;
		launchFailures?: number;
		backoffUntil?: number | null;
		draining?: boolean;
	} = {}
): string {
	const id = opts.id ?? `rnr_${++runnerSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
				default_tier, tiers, budget, config, secret_enc, last_seen_at, launch_failures, backoff_until, draining, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			opts.budget ? JSON.stringify(opts.budget) : null,
			JSON.stringify(opts.config ?? { harness: opts.harness ?? 'claude_code' }),
			opts.secretEnc ?? null,
			opts.lastSeen === undefined ? NOW : opts.lastSeen,
			opts.launchFailures ?? 0,
			opts.backoffUntil ?? null,
			opts.draining ? 1 : 0,
			NOW,
			NOW
		);
	return id;
}

let ruleSeq = 0;

export function addRule(
	t: TestDb,
	opts: {
		id?: string;
		project?: string | null;
		state?: string | null;
		label?: string | null;
		targets: RoutingTarget[];
	}
): string {
	const id = opts.id ?? `rul_${++ruleSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO routing_rule (id, user_id, project_id, workflow_state_id, label_id, targets, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			USER,
			opts.project ?? null,
			opts.state ?? null,
			opts.label ?? null,
			JSON.stringify(opts.targets),
			NOW,
			NOW
		);
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
		providerSessionId?: string | null;
		providerMeta?: string | null;
		createdAt?: number;
		startedAt?: number | null;
		endedAt?: number | null;
		stateAtEnd?: string | null;
		outcome?: string | null;
		usage?: string | null;
		log?: string;
		logBytesDropped?: number;
	}
): string {
	const id = opts.id ?? `arun_${++runSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, model,
				state_id_at_start, api_key_id, provider_session_id, provider_meta, log, log_bytes_dropped,
				created_at, started_at, ended_at, state_id_at_end, outcome, usage)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			opts.providerSessionId ?? null,
			opts.providerMeta ?? null,
			opts.log ?? '',
			opts.logBytesDropped ?? 0,
			opts.createdAt ?? NOW,
			opts.startedAt ?? null,
			opts.endedAt ?? null,
			opts.stateAtEnd ?? null,
			opts.outcome ?? null,
			opts.usage ?? null
		);
	return id;
}

/**
 * A run key: the `api_key` row with `agent_run_id` set that a run acts through.
 * Comments, events and artifact versions are attributed to a run only via one
 * of these, so every round scenario needs one per run.
 */
export function addRunKey(t: TestDb, runId: string, opts: { id?: string } = {}): string {
	const id = opts.id ?? `key_${runId}`;
	t.sqlite
		.prepare(
			`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(id, USER, `run ${runId}`, `hash_${id}`, id.slice(0, 8), runId, NOW);
	t.sqlite.prepare('UPDATE agent_run SET api_key_id = ? WHERE id = ?').run(id, runId);
	return id;
}

let commentSeq = 0;

/** A comment, optionally attributed to a run key. */
export function addComment(
	t: TestDb,
	opts: { issueId: string; body: string; apiKeyId?: string | null; at: number; id?: string }
): string {
	const id = opts.id ?? `cmt_${++commentSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO comment (id, issue_id, body, actor_user_id, actor_api_key_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(id, opts.issueId, opts.body, USER, opts.apiKeyId ?? null, opts.at);
	return id;
}

/** The Engineering-shaped workflow the round scenarios walk. */
export const ENG_STATES = {
	research: 'wfs_eng_research',
	design: 'wfs_eng_design',
	impl: 'wfs_eng_impl',
	autoReview: 'wfs_eng_auto',
	humanReview: 'wfs_eng_human'
} as const;

export function addEngineeringWorkflow(t: TestDb): void {
	t.sqlite.exec(`
		INSERT INTO workflow (id, user_id, name, initial_state_id, created_at, updated_at)
			VALUES ('wf_eng', '${USER}', 'Engineering', '${ENG_STATES.research}', ${NOW}, ${NOW});
		INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
			('${ENG_STATES.research}', 'wf_eng', 'Research', 'active', 0, ${NOW}),
			('${ENG_STATES.design}', 'wf_eng', 'Design', 'active', 1, ${NOW}),
			('${ENG_STATES.impl}', 'wf_eng', 'Implementation', 'active', 2, ${NOW}),
			('${ENG_STATES.autoReview}', 'wf_eng', 'Automated Review', 'active', 3, ${NOW}),
			('${ENG_STATES.humanReview}', 'wf_eng', 'Human Review', 'awaiting_human', 4, ${NOW});
	`);
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
		action?: string | null;
		fromName?: string;
		toName?: string;
		forced?: boolean;
		project?: string;
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
			opts.project ?? PROJECT,
			JSON.stringify({
				from_state_id: opts.from ?? OPEN,
				to_state_id: opts.to ?? REVIEW,
				...(opts.fromName === undefined ? {} : { from_state_name: opts.fromName }),
				...(opts.toName === undefined ? {} : { to_state_name: opts.toName }),
				...(opts.action === undefined || opts.action === null ? {} : { action: opts.action }),
				...(opts.forced ? { forced: true } : {})
			}),
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

export const MEMBER = 'u_member';

/**
 * A member-contributor run (Tines/751): a second user who is a current member
 * of the shared PROJECT at `revision`, their own runner, and a running run on
 * `issueId` admitted to PROJECT under that revision, with a run key in their
 * name whose bearer hashes to `keyHash`.
 */
export function addMemberContributorRun(
	t: TestDb,
	opts: { issueId: string; keyHash: string; revision?: number; memberId?: string }
): { memberId: string; runnerId: string; runId: string; keyId: string } {
	const memberId = opts.memberId ?? MEMBER;
	const revision = opts.revision ?? 1;
	t.sqlite.exec(`
		INSERT OR IGNORE INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('${memberId}', 'bob', '${memberId}@example.com', 1, ${NOW}, ${NOW});
		UPDATE project SET shared_at = coalesce(shared_at, ${NOW}) WHERE id = '${PROJECT}';
		INSERT OR REPLACE INTO project_member (project_id, user_id, revision, joined_at, updated_at)
			VALUES ('${PROJECT}', '${memberId}', ${revision}, ${NOW}, ${NOW});
	`);
	const runnerId = addRunner(t);
	t.sqlite.prepare('UPDATE runner SET user_id = ? WHERE id = ?').run(memberId, runnerId);
	const runId = addRun(t, { issueId: opts.issueId, runnerId, status: 'running' });
	const token = t.sqlite
		.prepare('SELECT project_assignment_token AS token FROM issue WHERE id = ?')
		.get(opts.issueId) as { token: string };
	t.sqlite
		.prepare(
			`UPDATE agent_run SET user_id = ?, admitted_project_id = ?, admitted_project_owner_id = ?,
				project_assignment_token = ?, admitted_membership_revision = ? WHERE id = ?`
		)
		.run(memberId, PROJECT, USER, token.token, revision, runId);
	const keyId = addRunKey(t, runId);
	t.sqlite
		.prepare('UPDATE api_key SET user_id = ?, key_hash = ?, permissions = ? WHERE id = ?')
		.run(
			memberId,
			opts.keyHash,
			JSON.stringify({
				version: 1,
				projects: { access: 'write', scope: 'all' },
				workspace: 'write',
				control_plane: 'read'
			}),
			keyId
		);
	return { memberId, runnerId, runId, keyId };
}
