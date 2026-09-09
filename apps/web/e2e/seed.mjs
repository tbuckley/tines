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
	HANDOFF,
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
for (const user of [ALICE, BOB, CAROL, PAGINATION.user]) {
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

// Full two-pass Engineering handoff. Artifact bytes are attached over HTTP by
// handoff.spec.ts so they exercise R2 and the real content route; the rows
// here provide the run attribution and historical transition timeline that
// cannot be authored through the public API after a run has finished.
const handoffBase = nowMs - 8 * 60 * 60 * 1000;
const handoffHour = 60 * 60 * 1000;
const handoffRuns = [
	['impl1', 'wfs_e2e_handoff_impl', 'wfs_e2e_handoff_auto', 1],
	['review1', 'wfs_e2e_handoff_auto', 'wfs_e2e_handoff_impl', 2],
	['impl2', 'wfs_e2e_handoff_impl', 'wfs_e2e_handoff_auto', 3],
	['review2', 'wfs_e2e_handoff_auto', 'wfs_e2e_handoff_human', 4]
];
statements.push(
	`INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
	 VALUES ('wf_e2e_handoff', '${ALICE.id}', 'Engineering handoff', '', 'wfs_e2e_handoff_impl', ${handoffBase}, ${handoffBase});`,
	`INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
	 ('wfs_e2e_handoff_impl', 'wf_e2e_handoff', 'Implementation', 'active', 0, ${handoffBase}),
	 ('wfs_e2e_handoff_auto', 'wf_e2e_handoff', 'Automated Review', 'active', 1, ${handoffBase}),
	 ('wfs_e2e_handoff_human', 'wf_e2e_handoff', 'Human Review', 'awaiting_human', 2, ${handoffBase}),
	 ('wfs_e2e_handoff_done', 'wf_e2e_handoff', 'Done', 'done', 3, ${handoffBase});`,
	`INSERT INTO workflow_transition (id, workflow_id, name, from_state_id, to_state_id) VALUES
	 ('wft_e2e_handoff_submit', 'wf_e2e_handoff', 'Submit for automated review', 'wfs_e2e_handoff_impl', 'wfs_e2e_handoff_auto'),
	 ('wft_e2e_handoff_fail', 'wf_e2e_handoff', 'Automated review failed', 'wfs_e2e_handoff_auto', 'wfs_e2e_handoff_impl'),
	 ('wft_e2e_handoff_pass', 'wf_e2e_handoff', 'Automated review passed', 'wfs_e2e_handoff_auto', 'wfs_e2e_handoff_human'),
	 ('wft_e2e_handoff_approve', 'wf_e2e_handoff', 'Approve', 'wfs_e2e_handoff_human', 'wfs_e2e_handoff_done'),
	 ('wft_e2e_handoff_back', 'wf_e2e_handoff', 'Send back to Implementation', 'wfs_e2e_handoff_human', 'wfs_e2e_handoff_impl');`,
	`INSERT INTO project (id, user_id, name, description, created_at, updated_at)
	 VALUES ('${HANDOFF.projectId}', '${ALICE.id}', '${HANDOFF.projectName}', '', ${handoffBase}, ${handoffBase});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at, state_entered_at)
	 VALUES ('${HANDOFF.issueId}', '${HANDOFF.projectId}', ${HANDOFF.issueNumber}, 'Rich handoff', 'Description marker',
	 'wf_e2e_handoff', 'wfs_e2e_handoff_human', ${handoffBase}, ${nowMs}, ${handoffBase + 4 * handoffHour + 1000});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at, state_entered_at)
	 VALUES ('${HANDOFF.foreignIssueId}', '${HANDOFF.projectId}', 2, 'Foreign run', '',
	 'wf_e2e_handoff', 'wfs_e2e_handoff_impl', ${handoffBase}, ${nowMs}, ${nowMs});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at, state_entered_at)
	 VALUES ('iss_e2e_handoff_oldest', '${HANDOFF.projectId}', 3, 'Oldest awaiting', '',
	 'wf_e2e_handoff', 'wfs_e2e_handoff_human', ${handoffBase}, ${nowMs}, ${nowMs - 6 * handoffHour});`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at, state_entered_at)
	 VALUES ('iss_e2e_handoff_newest', '${HANDOFF.projectId}', 4, 'Newest awaiting', '',
	 'wf_e2e_handoff', 'wfs_e2e_handoff_human', ${handoffBase}, ${nowMs}, ${nowMs - 10 * 60 * 1000});`,
	`INSERT INTO context_item (id, user_id, kind, name, description, workflow_state_id, body, position, version, created_at, updated_at)
	 VALUES ('ctx_e2e_handoff_instructions', '${ALICE.id}', 'prompt', 'instructions', '', 'wfs_e2e_handoff_human',
	 'Review the implementation and all evidence.\n\n- **Approve** → Done: accept the work\n- **Send back to Implementation** for required changes',
	 0, 1, ${handoffBase}, ${handoffBase});`,
	`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes, default_tier, config, created_at, updated_at)
	 VALUES ('rnr_e2e_handoff', '${ALICE.id}', 'local', 'handoff-runner', 'paused', 1, 30, 'balanced', '{}', ${handoffBase}, ${handoffBase});`
);
for (const [name, from, to, offset] of handoffRuns) {
	const runId = `arun_e2e_handoff_${name}`;
	const started = handoffBase + offset * handoffHour;
	statements.push(
		`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, state_id_at_start, state_id_at_end, created_at, started_at, ended_at)
		 VALUES ('${runId}', '${ALICE.id}', '${HANDOFF.issueId}', 'rnr_e2e_handoff', 'completed', 'advanced', 'balanced', 'test-model', '${from}', '${to}', ${started}, ${started}, ${started + 1000});`,
		`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at)
		 VALUES ('key_e2e_handoff_${name}', '${ALICE.id}', 'run:${name}', '${sha256Hex(HANDOFF.runKeys[name])}', '${HANDOFF.runKeys[name].slice(0, 14)}', ${started}, '${runId}', ${Date.parse(expires)});`
	);
}
const foreignStarted = handoffBase + 3 * handoffHour;
statements.push(
	`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, state_id_at_start, created_at, started_at, ended_at)
	 VALUES ('arun_e2e_handoff_foreign', '${ALICE.id}', '${HANDOFF.foreignIssueId}', 'rnr_e2e_handoff', 'completed', 'advanced', 'balanced', 'test-model', 'wfs_e2e_handoff_impl', ${foreignStarted}, ${foreignStarted}, ${foreignStarted + 1000});`,
	`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at)
	 VALUES ('key_e2e_handoff_foreign', '${ALICE.id}', 'run:foreign', '${sha256Hex(HANDOFF.runKeys.foreign)}', '${HANDOFF.runKeys.foreign.slice(0, 14)}', ${foreignStarted}, 'arun_e2e_handoff_foreign', ${Date.parse(expires)});`
);
const transitionNames = [
	[
		'impl1',
		'Submit for automated review',
		'Implementation',
		'Automated Review',
		'wfs_e2e_handoff_impl',
		'wfs_e2e_handoff_auto',
		1
	],
	[
		'review1',
		'Automated review failed',
		'Automated Review',
		'Implementation',
		'wfs_e2e_handoff_auto',
		'wfs_e2e_handoff_impl',
		2
	],
	[
		'impl2',
		'Submit for automated review',
		'Implementation',
		'Automated Review',
		'wfs_e2e_handoff_impl',
		'wfs_e2e_handoff_auto',
		3
	],
	[
		'review2',
		'Automated review passed',
		'Automated Review',
		'Human Review',
		'wfs_e2e_handoff_auto',
		'wfs_e2e_handoff_human',
		4
	]
];
for (const [name, action, fromName, toName, from, to, offset] of transitionNames) {
	const at = handoffBase + offset * handoffHour + 1000;
	statements.push(
		`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
		 VALUES ('evt_e2e_handoff_${name}', '${ALICE.id}', 'issue.transitioned', '${ALICE.id}', 'key_e2e_handoff_${name}', '${HANDOFF.issueId}', '${HANDOFF.projectId}',
		 '${JSON.stringify({ action, from_state_id: from, from_state_name: fromName, to_state_id: to, to_state_name: toName })}', ${at});`
	);
}
statements.push(
	`INSERT INTO comment (id, issue_id, body, actor_user_id, actor_api_key_id, created_at) VALUES
	 ('cmt_e2e_handoff_impl1', '${HANDOFF.issueId}', 'First implementation attempt', '${ALICE.id}', 'key_e2e_handoff_impl1', ${handoffBase + handoffHour + 500}),
	 ('cmt_e2e_handoff_review1', '${HANDOFF.issueId}', 'Review found a blocker', '${ALICE.id}', 'key_e2e_handoff_review1', ${handoffBase + 2 * handoffHour + 500}),
	 ('cmt_e2e_handoff_impl2', '${HANDOFF.issueId}', 'Implementation complete — ${HANDOFF.implementerTail}', '${ALICE.id}', 'key_e2e_handoff_impl2', ${handoffBase + 3 * handoffHour + 500}),
	 ('cmt_e2e_handoff_review2', '${HANDOFF.issueId}', 'Review passed — ${HANDOFF.reviewerTail}', '${ALICE.id}', 'key_e2e_handoff_review2', ${handoffBase + 4 * handoffHour + 500}),
	 ('cmt_e2e_handoff_stray', '${HANDOFF.issueId}', '${HANDOFF.strayBody}', '${ALICE.id}', 'key_e2e_handoff_foreign', ${handoffBase + 3 * handoffHour + 600});`
);
statements.push(
	`INSERT INTO workflow (id, user_id, name, description, initial_state_id, created_at, updated_at)
	 VALUES ('wf_e2e_prd', '${ALICE.id}', 'Product Direction handoff', '', 'wfs_e2e_prd_drafting', ${handoffBase}, ${handoffBase});`,
	`INSERT INTO workflow_state (id, workflow_id, name, category, position, created_at) VALUES
	 ('wfs_e2e_prd_drafting', 'wf_e2e_prd', 'Drafting', 'active', 0, ${handoffBase}),
	 ('wfs_e2e_prd_review', 'wf_e2e_prd', 'PRD Review', 'awaiting_human', 1, ${handoffBase});`,
	`INSERT INTO workflow_transition (id, workflow_id, name, from_state_id, to_state_id) VALUES
	 ('wft_e2e_prd_submit', 'wf_e2e_prd', 'Submit PRD for review', 'wfs_e2e_prd_drafting', 'wfs_e2e_prd_review'),
	 ('wft_e2e_prd_back', 'wf_e2e_prd', 'Revise PRD', 'wfs_e2e_prd_review', 'wfs_e2e_prd_drafting');`,
	`INSERT INTO issue (id, project_id, number, title, description, workflow_id, state_id, created_at, updated_at, state_entered_at)
	 VALUES ('${HANDOFF.prdIssueId}', '${HANDOFF.projectId}', ${HANDOFF.prdIssueNumber}, 'PRD handoff', '',
	 'wf_e2e_prd', 'wfs_e2e_prd_review', ${handoffBase}, ${nowMs}, ${handoffBase + handoffHour + 1000});`,
	`INSERT INTO context_item (id, user_id, kind, name, description, workflow_state_id, body, position, version, created_at, updated_at)
	 VALUES ('ctx_e2e_prd_instructions', '${ALICE.id}', 'prompt', 'instructions', '', 'wfs_e2e_prd_review',
	 'Decide whether this product direction is ready to deliver.\n\n- **Revise PRD** for gaps in the proposal', 0, 1, ${handoffBase}, ${handoffBase});`,
	`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, outcome, tier, model, state_id_at_start, state_id_at_end, created_at, started_at, ended_at)
	 VALUES ('arun_e2e_handoff_prd', '${ALICE.id}', '${HANDOFF.prdIssueId}', 'rnr_e2e_handoff', 'completed', 'advanced', 'balanced', 'test-model', 'wfs_e2e_prd_drafting', 'wfs_e2e_prd_review', ${handoffBase + handoffHour}, ${handoffBase + handoffHour}, ${handoffBase + handoffHour + 1000});`,
	`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at)
	 VALUES ('key_e2e_handoff_prd', '${ALICE.id}', 'run:prd', '${sha256Hex(HANDOFF.runKeys.prd)}', '${HANDOFF.runKeys.prd.slice(0, 14)}', ${handoffBase + handoffHour}, 'arun_e2e_handoff_prd', ${Date.parse(expires)});`,
	`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
	 VALUES ('evt_e2e_handoff_prd', '${ALICE.id}', 'issue.transitioned', '${ALICE.id}', 'key_e2e_handoff_prd', '${HANDOFF.prdIssueId}', '${HANDOFF.projectId}',
	 '{"action":"Submit PRD for review","from_state_id":"wfs_e2e_prd_drafting","from_state_name":"Drafting","to_state_id":"wfs_e2e_prd_review","to_state_name":"PRD Review"}', ${handoffBase + handoffHour + 1000});`,
	`INSERT INTO comment (id, issue_id, body, actor_user_id, actor_api_key_id, created_at)
	 VALUES ('cmt_e2e_handoff_prd', '${HANDOFF.prdIssueId}', 'Drafting complete with every open question included.', '${ALICE.id}', 'key_e2e_handoff_prd', ${handoffBase + handoffHour + 500});`,
	`INSERT INTO context_item (id, user_id, kind, name, description, issue_id, config, position, version, created_at, updated_at)
	 VALUES ('ctx_e2e_handoff_prd_artifact', '${ALICE.id}', 'artifact', 'prd', '', '${HANDOFF.prdIssueId}', '{"artifact_type":"text"}', 0, 1, ${handoffBase + handoffHour + 500}, ${handoffBase + handoffHour + 500});`,
	`INSERT INTO artifact_version (id, context_item_id, version, content_type, size_bytes, content, actor_user_id, actor_api_key_id, created_at)
	 VALUES ('av_e2e_handoff_prd', 'ctx_e2e_handoff_prd_artifact', 1, 'text/markdown', 35, '# Direction\n\nThe complete proposal.', '${ALICE.id}', 'key_e2e_handoff_prd', ${handoffBase + handoffHour + 600});`
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
