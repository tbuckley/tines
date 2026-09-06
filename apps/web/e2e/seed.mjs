/**
 * Seeds the local e2e D1 database with two users, one session each, and one
 * API key each. Run after migrations, before `wrangler dev` (see server.sh).
 *
 * Better Auth reads sessions from its own tables; inserting a user + session
 * row directly (dates as ISO strings, which its sqlite adapter parses) plus
 * a signed cookie in the tests is enough to act as a signed-in browser.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ALICE,
	BOB,
	CAROL,
	DANA,
	PAGINATION,
	RUNROW,
	RUNROW_FAILED,
	SCHED
} from './constants.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

const nowIso = new Date().toISOString();
const nowMs = Date.now();
const expires = '2030-01-01T00:00:00.000Z';

const statements = [];
for (const user of [ALICE, BOB, CAROL, DANA, PAGINATION.user]) {
	statements.push(
		`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
		 VALUES ('${user.id}', '${user.name}', '${user.email}', 1, '${nowIso}', '${nowIso}');`,
		`INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId)
		 VALUES ('ses_${user.id}', '${expires}', '${user.sessionToken}', '${nowIso}', '${nowIso}', '${user.id}');`,
		`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at)
		 VALUES ('key_${user.id}', '${user.id}', '${user.apiKeyName}', '${sha256Hex(user.apiKey)}', '${user.apiKey.slice(0, 14)}', ${nowMs});`
	);
}

// A separate account keeps these 205 rows from slowing or changing every
// existing Alice/Bob list assertion. Descending timestamps make the visible
// boundaries explicit: 205..106, then 105..6, then 5..1.
statements.push(
	`INSERT INTO project (id, user_id, name, description, created_at, updated_at)
	 VALUES ('${PAGINATION.projectId}', '${PAGINATION.user.id}', '${PAGINATION.projectName}', '', ${nowMs}, ${nowMs});`
);
for (let number = 1; number <= 205; number += 1) {
	statements.push(
		`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
		 VALUES ('iss_e2e_page_${number}', '${PAGINATION.projectId}', ${number}, 'Page issue ${number}',
		 'large body omitted from list ${number}', 'wf_standard', 'wfs_std_open', ${number}, ${number});`
	);
}

// Scheduled-task fixtures for the sweep specs: a project of Alice's with two
// due schedules (next_run_at in the past — unreachable through the API, which
// always computes a future occurrence) and one open instance blocking the
// gated one. The sweep is fired on demand via wrangler's --test-scheduled.
const due = nowMs - 60_000;
statements.push(
	`INSERT INTO project (id, user_id, name, description, created_at, updated_at)
	 VALUES ('${SCHED.projectId}', '${ALICE.id}', '${SCHED.projectName}', '', ${nowMs}, ${nowMs});`,
	`INSERT INTO scheduled_task (id, project_id, name, title_template, description_template, workflow_id,
	   cron, preset, timezone, require_all_closed, enabled, next_run_at, run_count, created_at, updated_at)
	 VALUES ('${SCHED.plainId}', '${SCHED.projectId}', '${SCHED.plainName}',
	   'Daily report {{date}} #{{count}}', 'Report for {{schedule_name}} at {{datetime}}', 'wf_standard',
	   '0 9 * * *', '{"kind":"daily","time":"09:00"}', 'UTC', 0, 1, ${due}, 0, ${nowMs}, ${nowMs});`,
	`INSERT INTO scheduled_task (id, project_id, name, title_template, description_template, workflow_id,
	   cron, preset, timezone, require_all_closed, enabled, next_run_at, run_count, created_at, updated_at)
	 VALUES ('${SCHED.gatedId}', '${SCHED.projectId}', '${SCHED.gatedName}',
	   'Gated triage {{count}}', '', 'wf_standard',
	   '0 9 * * *', '{"kind":"daily","time":"09:00"}', 'UTC', 1, 1, ${due}, 1, ${nowMs}, ${nowMs});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, scheduled_task_id, created_at, updated_at)
	 VALUES ('${SCHED.gatedIssueId}', '${SCHED.projectId}', 1, 'Gated triage 1', '', 'wf_standard', 'wfs_std_open',
	   '${SCHED.gatedId}', ${nowMs}, ${nowMs});`
);

// Managed-run fixture for the run-row spec: a finished run carrying a cost,
// a provider console URL and a provider session id. `provider_url` is
// unreachable through the API (only an adapter writes it, at launch), so the
// row is seeded here — see RUNROW in constants.mjs for why it is `completed`.
const runStart = nowMs - 120_000;
statements.push(
	`INSERT INTO project (id, user_id, name, description, created_at, updated_at)
	 VALUES ('${RUNROW.projectId}', '${ALICE.id}', '${RUNROW.projectName}', '', ${nowMs}, ${nowMs});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at)
	 VALUES ('${RUNROW.issueId}', '${RUNROW.projectId}', ${RUNROW.issueNumber}, 'Managed run row', '',
	   'wf_standard', 'wfs_std_open', ${nowMs}, ${nowMs});`,
	`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier,
	   config, created_at, updated_at)
	 VALUES ('${RUNROW.runnerId}', '${ALICE.id}', 'claude_managed', '${RUNROW.runnerName}', 'active', 1, 30,
	   'balanced', '{}', ${nowMs}, ${nowMs});`,
	`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage,
	   state_id_at_start, state_id_at_end, provider_session_id, provider_url, log, error,
	   created_at, started_at, ended_at)
	 VALUES ('${RUNROW.runId}', '${ALICE.id}', '${RUNROW.issueId}', '${RUNROW.runnerId}', 'completed',
	   '${RUNROW.outcome}',
	   'balanced', 'claude-opus-4', '{"input_tokens":1000,"output_tokens":2000,"cost_usd":${RUNROW.costUsd},"cost_source":"provider"}',
	   'wfs_std_open', 'wfs_std_open', '${RUNROW.providerSessionId}', '${RUNROW.providerUrl}', 'seeded log tail', NULL,
	   ${runStart}, ${runStart}, ${nowMs});`,
	// The run's key, for the run-key fence cases in api.spec.ts. Inserted after
	// the agent_run row it references (api_key.agent_run_id is a FK); expiry is
	// the same far-future date the sessions use, so the sweep never revokes it.
	`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at)
	 VALUES ('key_e2e_runrow', '${ALICE.id}', '${RUNROW.runKeyName}', '${sha256Hex(RUNROW.runKey)}',
	   '${RUNROW.runKey.slice(0, 14)}', ${nowMs}, '${RUNROW.runId}', ${Date.parse(expires)});`,
	// A second run on the same issue, this one failed with a long error: the
	// row clamps it to two lines and the Logs disclosure carries it whole.
	// Its own runner keeps every `hasText: <runner name>` row selector at one
	// match on both the issue page and the Agents tab.
	`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier,
	   config, created_at, updated_at)
	 VALUES ('${RUNROW_FAILED.runnerId}', '${ALICE.id}', 'local', '${RUNROW_FAILED.runnerName}', 'paused', 1, 30,
	   'balanced', '{}', ${nowMs}, ${nowMs});`,
	`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, usage,
	   state_id_at_start, state_id_at_end, provider_session_id, provider_url, log, error,
	   created_at, started_at, ended_at)
	 VALUES ('${RUNROW_FAILED.runId}', '${ALICE.id}', '${RUNROW.issueId}', '${RUNROW_FAILED.runnerId}', 'failed',
	   'stalled',
	   'balanced', NULL, NULL,
	   'wfs_std_open', 'wfs_std_open', NULL, NULL, 'seeded failed log tail', '${RUNROW_FAILED.error}',
	   ${runStart}, ${runStart}, ${nowMs});`,
	// This run ended, so its key is revoked — the fixture behind the API keys
	// page's "Show revoked" toggle. Inserted after its agent_run row (FK).
	`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at, revoked_at)
	 VALUES ('key_e2e_runrow_failed', '${ALICE.id}', '${RUNROW_FAILED.runKeyName}',
	   '${sha256Hex(RUNROW_FAILED.runKey)}', '${RUNROW_FAILED.runKey.slice(0, 14)}', ${runStart},
	   '${RUNROW_FAILED.runId}', ${Date.parse(expires)}, ${nowMs});`
);

const sqlFile = join(mkdtempSync(join(tmpdir(), 'tines-e2e-')), 'seed.sql');
writeFileSync(sqlFile, statements.join('\n'));

execFileSync(
	'pnpm',
	[
		'exec',
		'wrangler',
		'd1',
		'execute',
		'tines',
		'--local',
		'--persist-to',
		'.wrangler-e2e',
		'--file',
		sqlFile
	],
	{ stdio: 'inherit' }
);
console.log('e2e seed complete');
