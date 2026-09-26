import { expect, test } from './fixtures';
import { ALICE, BOB, BASE_URL } from './constants.mjs';
import { apiClient, body, signedSessionCookie } from './helpers';
import { d1, sqlLiteral } from './d1';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Tines/751: a member's run key is bound to its contributor, runner, admitted
// project and membership revision, and native D1 re-checks that binding in the
// same batch as the write. The race hook changes state after preflight.

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli/', import.meta.url));
function cli(key: string, ...args: string[]) {
	return execFileSync('pnpm', ['exec', 'tsx', 'src/index.ts', ...args], {
		cwd: CLI_DIR,
		env: { ...process.env, TINES_API_URL: BASE_URL, TINES_API_KEY: key },
		encoding: 'utf8'
	});
}

const count = (sql: string) => d1<{ n: number }>(sql)[0].n;

test('a member run key writes only while its binding holds, on native D1', async ({
	request,
	uniqueName
}) => {
	test.setTimeout(180_000);
	const owner = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string; name: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('run-contributor') })
	);
	const elsewhere = await body<{ id: string }>(
		await owner.post('/api/v1/projects', { name: uniqueName('run-contributor-elsewhere') })
	);
	const workflow = await body<{ id: string }>(
		await owner.post('/api/v1/workflows', {
			name: uniqueName('run-contributor-workflow'),
			initial_state: 'Working',
			states: [
				{ name: 'Working', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' }
			],
			transitions: [{ name: 'Review', from: 'Working', to: 'Review' }]
		})
	);
	const invite = await body<{ id: string }>(
		await owner.post(`/api/v1/projects/${project.id}/invitations`, {
			email: BOB.email,
			confirm_sharing: true,
			expected_sharing_revision: 0
		})
	);
	const sink = await body<{ url: string }>(
		await request.get(`/api/v1/__e2e/invitation-email/${invite.id}`)
	);
	await body(
		await request.post('/api/v1/invitations/accept', {
			headers: {
				cookie: `better-auth.session_token=${signedSessionCookie(BOB.sessionToken)}`,
				origin: BASE_URL
			},
			data: { token: sink.url.split('/').at(-1) }
		})
	);
	const runnerId = `rnr_751_${project.id}`;
	const now = Date.now();
	d1(`INSERT INTO runner (id, user_id, type, name, status, max_concurrent, max_run_minutes,
		default_tier, config, last_seen_at, created_at, updated_at)
		VALUES (${sqlLiteral(runnerId)}, ${sqlLiteral(BOB.id)}, 'local', 'bob-runner', 'active', 1, 30,
		'balanced', '{}', ${now}, ${now}, ${now})`);

	let seq = 0;
	/** A fresh issue with a live member run bound at the current membership revision. */
	async function memberRun() {
		seq += 1;
		const issue = await body<{ id: string; number: number }>(
			await owner.post(`/api/v1/projects/${project.id}/issues`, {
				title: `Member run ${seq}`,
				workflow_id: workflow.id
			})
		);
		const [row] = d1<{ state_id: string; token: string; revision: number }>(
			`SELECT i.state_id, i.project_assignment_token AS token, m.revision
			FROM issue i JOIN project_member m ON m.project_id = i.project_id
			WHERE i.id = ${sqlLiteral(issue.id)} AND m.user_id = ${sqlLiteral(BOB.id)}`
		);
		const runId = `arun_751_${project.id}_${seq}`;
		const keyId = `key_751_${project.id}_${seq}`;
		const secret = `e2e-run-751-${project.id}-${seq}`;
		const at = Date.now();
		d1(`INSERT INTO agent_run (id, user_id, issue_id, runner_id, status, tier, log, created_at,
			started_at, state_id_at_start, admitted_project_id, admitted_project_owner_id,
			project_assignment_token, admitted_membership_revision)
			VALUES (${sqlLiteral(runId)}, ${sqlLiteral(BOB.id)}, ${sqlLiteral(issue.id)},
			${sqlLiteral(runnerId)}, 'running', 'balanced', '', ${at}, ${at}, ${sqlLiteral(row.state_id)},
			${sqlLiteral(project.id)}, ${sqlLiteral(ALICE.id)}, ${sqlLiteral(row.token)}, ${row.revision})`);
		d1(`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, created_at, agent_run_id, expires_at)
			VALUES (${sqlLiteral(keyId)}, ${sqlLiteral(BOB.id)}, 'member run key',
			${sqlLiteral(createHash('sha256').update(secret).digest('hex'))},
			${sqlLiteral(secret.slice(0, 14))}, ${at}, ${sqlLiteral(runId)}, ${at + 86_400_000})`);
		d1(`UPDATE agent_run SET api_key_id = ${sqlLiteral(keyId)} WHERE id = ${sqlLiteral(runId)}`);
		return { issue, secret, ref: `${project.name}/${issue.number}` };
	}

	function restoreMembership() {
		d1(`UPDATE project_member SET revoked_at = NULL, revision = revision + 1
			WHERE project_id = ${sqlLiteral(project.id)} AND user_id = ${sqlLiteral(BOB.id)}`);
	}

	// Positive control, through the CLI: a live member run reads and writes its issue.
	{
		const { issue, secret, ref } = await memberRun();
		expect(cli(secret, 'issues', 'show', ref)).toContain(`Member run ${seq}`);
		cli(secret, 'issues', 'comment', ref, 'from the member run');
		expect(
			count(
				`SELECT COUNT(*) AS n FROM comment WHERE issue_id = ${sqlLiteral(issue.id)}
				AND body = 'from the member run'`
			)
		).toBe(1);
		// The journal read resolves the run's bound anchor in the owner's project; none exists yet.
		let journal = '';
		try {
			journal = cli(secret, 'journal', 'show', ref);
		} catch (error) {
			journal = String((error as { stderr?: string }).stderr);
		}
		expect(journal).toContain(`no journal exists yet for project ${project.name} · state Working`);
		// The comment lands once, in the owner's project, credited to the member.
		expect(
			count(
				`SELECT COUNT(*) AS n FROM event WHERE issue_id = ${sqlLiteral(issue.id)}
				AND type = 'issue.commented' AND user_id = ${sqlLiteral(ALICE.id)}
				AND actor_user_id = ${sqlLiteral(BOB.id)}`
			)
		).toBe(1);
	}

	const races = ['cancel-run', 'expire-key', 'remove', 'rejoin', 'transfer'] as const;
	// Member-run transitions are not delegated yet (transitionMemberIssue refuses runs).
	for (const write of ['comment', 'transition'] as const) {
		for (const race of races) {
			const { issue, secret } = await memberRun();
			const events = count(
				`SELECT COUNT(*) AS n FROM event WHERE issue_id = ${sqlLiteral(issue.id)}`
			);
			const headers: Record<string, string> = {
				authorization: `Bearer ${secret}`,
				'x-tines-e2e-member-write-race': race
			};
			if (race === 'transfer') headers['x-tines-e2e-member-race-target'] = elsewhere.id;
			const response =
				write === 'comment'
					? await request.post(`/api/v1/issues/${issue.id}/comments`, {
							headers,
							data: { body: `late ${race}` }
						})
					: await request.post(`/api/v1/issues/${issue.id}/transition`, {
							headers,
							data: { action: 'Review' }
						});
			expect([401, 404, 409], `${write} after ${race}`).toContain(response.status());
			expect(
				count(
					`SELECT COUNT(*) AS n FROM comment WHERE issue_id = ${sqlLiteral(issue.id)}
					AND body = ${sqlLiteral(`late ${race}`)}`
				),
				`${write} after ${race}`
			).toBe(0);
			expect(
				d1<{ name: string }>(
					`SELECT s.name FROM issue i JOIN workflow_state s ON s.id = i.state_id
					WHERE i.id = ${sqlLiteral(issue.id)}`
				)[0].name,
				`${write} after ${race}`
			).toBe('Working');
			expect(
				count(`SELECT COUNT(*) AS n FROM event WHERE issue_id = ${sqlLiteral(issue.id)}`),
				`${write} after ${race}`
			).toBe(events);
			if (race === 'remove') restoreMembership();
		}
	}
});
