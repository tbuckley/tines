/**
 * Shared constants for the e2e suite. `seed.mjs` (plain node) writes these
 * into the local D1 database before `wrangler dev` starts; the Playwright
 * specs use the same values to authenticate.
 *
 * Everything here is test-only and never touches a real deployment: the
 * server is started with BETTER_AUTH_SECRET below and a throwaway D1 state
 * dir (.wrangler-e2e), recreated on every server start.
 */

export const PORT = Number(process.env.E2E_PORT ?? 8788);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
/** 32+ high-entropy characters, or Better Auth warns twice at every server start. */
export const AUTH_SECRET =
	'tines-e2e-secret-4b8e1c3f9a2d7e5b0c6f1a8d3e9b2c7f4a1e6d0b5c8f3a2e7d9b4c1f6a0e3d8b';

export const ALICE = {
	id: 'usr_e2e_alice',
	name: 'Alice E2E',
	email: 'alice@e2e.test',
	apiKey: 'tines_e2ealice0000000000000000000000000000000000',
	apiKeyName: 'alice-key',
	sessionToken: 'e2e-session-alice'
};

/** A second independently attributed writer for native concurrency races. */
export const ALICE_AGENT = {
	id: 'key_e2e_alice_agent',
	apiKey: 'tines_e2ealiceagent00000000000000000000000000000',
	apiKeyName: 'alice-agent-key'
};

/** Dedicated real-ledger account for the Agents Spend journeys. */
export const SPEND = {
	id: 'usr_e2e_spend',
	name: 'Spend E2E',
	email: 'spend@e2e.test',
	apiKey: 'tines_e2espend00000000000000000000000000000000000',
	apiKeyName: 'spend-key',
	sessionToken: 'e2e-session-spend',
	projects: {
		alpha: { id: 'prj_e2e_spend_alpha', name: 'Spend Alpha' },
		beta: { id: 'prj_e2e_spend_beta', name: 'Spend Beta' },
		empty: { id: 'prj_e2e_spend_empty', name: 'Spend Empty' },
		pending: { id: 'prj_e2e_spend_pending', name: 'Spend Pending' },
		unreported: { id: 'prj_e2e_spend_unreported', name: 'Spend Unreported' },
		tokens: { id: 'prj_e2e_spend_tokens', name: 'Spend Tokens' },
		zero: { id: 'prj_e2e_spend_zero', name: 'Spend Zero' },
		archived: { id: 'prj_e2e_spend_archived', name: 'Spend Archived' }
	},
	workflows: {
		build: { id: 'wf_e2e_spend_build', name: 'Build' },
		ship: { id: 'wf_e2e_spend_ship', name: 'Ship' },
		unknown: { id: 'wf_e2e_spend_unknown', name: 'Unknown cost' }
	}
};

/**
 * Seeded scheduled-task fixtures (Alice's): the sweep can only be tested
 * deterministically with `next_run_at` already in the past, which the API
 * never produces — so seed.mjs writes these rows directly.
 */
export const SCHED = {
	projectId: 'prj_e2e_sched',
	projectName: 'sched-seed',
	/** No gate; due at seed time. */
	plainId: 'sch_e2e_plain',
	plainName: 'Daily report',
	/** Gated (require_all_closed) with one seeded open instance; due at seed time. */
	gatedId: 'sch_e2e_gated',
	gatedName: 'Gated triage',
	gatedIssueId: 'iss_e2e_gated_1'
};

/**
 * Seeded managed-run fixture (Alice's), for the run-row spec. A run's
 * `provider_url` is written only by an adapter at launch — no API request
 * body carries it — so the row is seeded directly. `completed` rather than
 * `running` on purpose: a live run would hold the issue's claim and be
 * failed by any sweep firing after RUNNER_OFFLINE_FAIL_MS, i.e. flake.
 */
export const RUNROW = {
	projectId: 'prj_e2e_runrow',
	projectName: 'runrow-seed',
	issueId: 'iss_e2e_runrow_1',
	issueNumber: 1,
	runnerId: 'rnr_e2e_runrow',
	runnerName: 'runrow-managed',
	runId: 'run_e2e_runrow',
	/** Rendered by runCostLabel as "$1.23". */
	costUsd: 1.23,
	costLabel: '$1.23',
	/** How the end was judged: rendered beside the status on every run row. */
	outcome: 'advanced',
	providerUrl: 'https://console.example.test/session/e2e-runrow',
	providerSessionId: 'sess_e2e_runrow',
	/**
	 * A *run key* for this run: an `api_key` row with `agent_run_id` set, which
	 * is the only way to exercise the run-key control-plane fence over HTTP
	 * (a real run's key is minted at launch and revoked when the run ends).
	 * Safe on a `completed` run: keys are revoked by the run-end transition,
	 * which already happened for this seeded row, and by the sweep's
	 * `expires_at <= now` predicate, which the 2030 expiry keeps clear.
	 */
	runKey: 'tines_e2erunrow000000000000000000000000000000000',
	runKeyName: 'run:runrow'
};

/**
 * Seeded *failed* run (Alice's), on the same issue as RUNROW: a run's `error`
 * is written only when a runner reports a finish, so the row is seeded. Its
 * own runner, so each spec's `hasText: <runner name>` still selects exactly
 * one row on both surfaces — and paused, so the supervisor can never dispatch
 * to it and add a second run to the issue.
 */
export const RUNROW_FAILED = {
	runnerId: 'rnr_e2e_runrow_failed',
	runnerName: 'runrow-failed',
	runId: 'run_e2e_runrow_failed',
	resumedFromRunId: RUNROW.runId,
	providerSessionId: 'thread_e2e_codex',
	tokenLabel: '1,100 tok',
	/**
	 * A real ENOSPC message: long enough to overflow two clamped lines in the
	 * issue sidebar, so the row test measures a clamp rather than a short
	 * string that happens to fit.
	 */
	error:
		'harness exited 1: ENOSPC: no space left on device, write ' +
		'/Users/runner/.config/tines/workspaces/arun_9Xq2TbW/tines/node_modules/.vite/deps/chunk-4QWERTY.js',
	/**
	 * This run's key, seeded *already revoked* — the API keys page hides
	 * revoked run keys until "Show revoked" is ticked, and that is the only
	 * fixture proving it. Being revoked it can never authenticate, so unlike
	 * RUNROW.runKey it cannot perturb api.spec.ts's run-key fence cases.
	 */
	runKey: 'tines_e2efailedrun000000000000000000000000000000',
	runKeyName: 'run:runrow-failed'
};

export const RUNROW_ESTIMATED = {
	runnerId: 'rnr_e2e_runrow_estimated',
	runnerName: 'runrow-codex-priced',
	runId: 'run_e2e_runrow_estimated',
	issueId: 'iss_e2e_runrow_estimated',
	issueNumber: 2
};

/**
 * Seeded event presentations for the shared Activity feed. These rows cover
 * the outcome precedence and conservative fallback without launching agents.
 */
export const ACTIVITY_RUN_EVENTS = {
	projectId: 'prj_e2e_activity_runs',
	projectName: 'activity-runs-seed',
	issueId: 'iss_e2e_activity_runs_1',
	issueNumber: 1,
	events: [
		{ id: 'evt_e2e_activity_started', type: 'agent_run.started', runner: 'activity-start' },
		{ id: 'evt_e2e_activity_completed', type: 'agent_run.ended', runner: 'activity-success' },
		{ id: 'evt_e2e_activity_failed', type: 'agent_run.ended', runner: 'activity-failure' },
		{
			id: 'evt_e2e_activity_interrupted',
			type: 'agent_run.ended',
			runner: 'activity-interrupted'
		},
		{ id: 'evt_e2e_activity_stalled', type: 'agent_run.ended', runner: 'activity-stalled' },
		{ id: 'evt_e2e_activity_unknown', type: 'agent_run.ended', runner: 'activity-unknown' }
	]
};

/**
 * A third account with **no projects of its own**, for the "hidden below two
 * projects" half of the project switcher (Tines/259). Bob cannot serve: the
 * library spec imports projects for him.
 */
export const CAROL = {
	id: 'usr_e2e_carol',
	name: 'Carol E2E',
	email: 'carol@e2e.test',
	apiKey: 'tines_e2ecarol00000000000000000000000000000000000',
	apiKeyName: 'carol-key',
	sessionToken: 'e2e-session-carol'
};

export const BOB = {
	id: 'usr_e2e_bob',
	name: 'Bob E2E',
	email: 'bob@e2e.test',
	apiKey: 'tines_e2ebob000000000000000000000000000000000000',
	apiKeyName: 'bob-key',
	sessionToken: 'e2e-session-bob'
};

/** Independent empty accounts: these specs must be runnable in any order. */
export const AGENTS_FIRST_RUN = {
	id: 'usr_e2e_agents_first_run',
	name: 'Agents First Run E2E',
	email: 'agents-first-run@e2e.test',
	apiKey: 'tines_e2eagentsfirstrun000000000000000000000000000',
	apiKeyName: 'agents-first-run-key',
	sessionToken: 'e2e-session-agents-first-run'
};
export const API_ISOLATION = {
	id: 'usr_e2e_api_isolation',
	name: 'API Isolation E2E',
	email: 'api-isolation@e2e.test',
	apiKey: 'tines_e2eapiisolation00000000000000000000000000000',
	apiKeyName: 'api-isolation-key',
	sessionToken: 'e2e-session-api-isolation'
};
export const EXPLAINER_REMEDIES = {
	id: 'usr_e2e_explainer_remedies',
	name: 'Explainer Remedies E2E',
	email: 'explainer-remedies@e2e.test',
	apiKey: 'tines_e2eexplainerremedies0000000000000000000000000',
	apiKeyName: 'explainer-remedies-key',
	sessionToken: 'e2e-session-explainer-remedies'
};
export const STOPPED_FIRST_RUN = {
	id: 'usr_e2e_stopped_first_run',
	name: 'Stopped First Run E2E',
	email: 'stopped-first-run@e2e.test',
	apiKey: 'tines_e2estoppedfirstrun000000000000000000000000000',
	apiKeyName: 'stopped-first-run-key',
	sessionToken: 'e2e-session-stopped-first-run'
};
export const MANAGED_SETTINGS = {
	id: 'usr_e2e_managed_settings',
	name: 'Managed Settings E2E',
	email: 'managed-settings@e2e.test',
	apiKey: 'tines_e2emanagedsettings0000000000000000000000000000',
	apiKeyName: 'managed-settings-key',
	sessionToken: 'e2e-session-managed-settings'
};

/** Isolated real-D1 fixtures for project-transfer dispatch acceptance. */
export const TRANSFER_RUNTIME = {
	id: 'usr_e2e_transfer_runtime',
	name: 'Transfer Runtime E2E',
	email: 'transfer-runtime@e2e.test',
	apiKey: 'tines_e2etransferruntime00000000000000000000000000',
	apiKeyName: 'transfer-runtime-key',
	sessionToken: 'e2e-session-transfer-runtime',
	sourceId: 'prj_e2e_transfer_source',
	sourceName: 'transfer-runtime-source',
	destinationId: 'prj_e2e_transfer_destination',
	destinationName: 'transfer-runtime-destination',
	noopIssueId: 'iss_e2e_transfer_noop',
	claimIssueId: 'iss_e2e_transfer_claim',
	runnerId: 'rnr_e2e_transfer',
	runnerName: 'transfer-runtime-local',
	ruleId: 'rrl_e2e_transfer_destination'
};

/** Isolated 205-row population for issue-list pagination. */
export const PAGINATION = {
	user: {
		id: 'usr_e2e_pagination',
		name: 'Pagination E2E',
		email: 'pagination@e2e.test',
		apiKey: 'tines_e2epagination000000000000000000000000000000',
		apiKeyName: 'pagination-key',
		sessionToken: 'e2e-session-pagination'
	},
	projectId: 'prj_e2e_pagination',
	projectName: 'pagination-seed'
};

/**
 * A third seeded account, for the first-run checklist walk. Dana starts with
 * no projects, no runners, no rules and — the point — no agent runs, which is
 * the only state in which the checklist is shown at all (it retires
 * account-wide on the first run, and is derived, so there is nothing to
 * reset).
 *
 * `first-run-checklist.spec.ts` walks her all the way to a real run, so the
 * account is one-way: no other spec may depend on Dana being run-free, and
 * anything added to that file must sort after the walk inside it.
 */
export const DANA = {
	id: 'usr_e2e_dana',
	name: 'Dana E2E',
	email: 'dana@e2e.test',
	apiKey: 'tines_e2edana00000000000000000000000000000000000',
	apiKeyName: 'dana-key',
	sessionToken: 'e2e-session-dana'
};
