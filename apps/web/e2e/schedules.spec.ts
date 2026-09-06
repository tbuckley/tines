import type {
	CreateIssueResponse,
	Issue,
	IssueDetail,
	ListResponse,
	Project,
	Schedule,
	TinesEvent,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB, SCHED } from './constants.mjs';
import { apiClient, body, clickUntil, errorBody, resetFocus, runId, signIn } from './helpers';

// Specs share one user: a project page sets the focus (Tines/259), so clear it
// before each test rather than letting it scope a later spec's lists.
test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

/** Today's ISO date in UTC — the seeded schedules render {{date}} in UTC. */
const todayUtc = () => new Date().toISOString().slice(0, 10);
/** Today (YYYY-MM-DD) in a schedule's timezone — {{date}} renders in it. */
const todayIn = (timeZone: string) =>
	new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(new Date());

const fireSweep = async (request: import('@playwright/test').APIRequestContext) => {
	// wrangler dev --test-scheduled exposes the scheduled() handler here.
	const res = await request.get('/__scheduled?cron=*+*+*+*+*');
	expect(res.ok()).toBe(true);
};

test.describe.serial('scheduled-task sweep (seeded due schedules)', () => {
	test('creates an instance for a due schedule with rendered placeholders', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		await fireSweep(request);

		const issues = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/issues?schedule=${SCHED.plainId}`)
		);
		expect(issues.items.length).toBeGreaterThanOrEqual(1);
		const instance = issues.items[issues.items.length - 1];
		expect(instance.title).toBe(`Daily report ${todayUtc()} #1`);
		expect(instance.scheduled_task_id).toBe(SCHED.plainId);
		expect(instance.scheduled_task_name).toBe(SCHED.plainName);
		expect(instance.description).toContain(`Report for ${SCHED.plainName} at ${todayUtc()}`);

		const schedule = await body<Schedule>(await api.get(`/api/v1/schedules/${SCHED.plainId}`));
		expect(schedule.run_count).toBeGreaterThanOrEqual(1);
		expect(schedule.next_run_at).toBeGreaterThan(Date.now());
		expect(schedule.last_run_at).not.toBeNull();
	});

	test('attributes the sweep-created issue to the owner via the schedule', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?project=${SCHED.projectId}&type=issue.created`)
		);
		const created = events.items.find((e) => e.payload.scheduled_task_id === SCHED.plainId);
		expect(created).toBeDefined();
		expect(created!.actor.user_id).toBe(ALICE.id);
		expect(created!.actor.api_key_id).toBeNull();
		expect(created!.payload.scheduled_task_name).toBe(SCHED.plainName);
		expect(created!.payload.manual).toBeUndefined();
	});

	test('skips a gated schedule while an instance is open, recording the blockers', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		// Still only the seeded open instance — the occurrence was skipped.
		const issues = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/issues?schedule=${SCHED.gatedId}`)
		);
		expect(issues.items).toHaveLength(1);
		expect(issues.items[0].id).toBe(SCHED.gatedIssueId);

		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?project=${SCHED.projectId}&type=scheduled_task.skipped`)
		);
		expect(events.items.length).toBeGreaterThanOrEqual(1);
		const skipped = events.items[0];
		expect(skipped.payload.name).toBe(SCHED.gatedName);
		expect(skipped.payload.blocking).toEqual([{ issue_id: SCHED.gatedIssueId, number: 1 }]);

		// Skips are terminal: next_run_at advanced past the missed occurrence.
		const schedule = await body<Schedule>(await api.get(`/api/v1/schedules/${SCHED.gatedId}`));
		expect(schedule.next_run_at).toBeGreaterThan(Date.now());
	});

	test('a second sweep is a no-op (nothing due anymore)', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const before = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/issues?schedule=${SCHED.plainId}`)
		);
		await fireSweep(request);
		const after = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/issues?schedule=${SCHED.plainId}`)
		);
		expect(after.items).toHaveLength(before.items.length);
	});
});

test.describe.serial('schedule lifecycle over the API', () => {
	const projectName = `sched-${runId}`;
	let projectId: string;
	let scheduleId: string;
	let firstIssue: IssueDetail;

	test('creating an issue with a recurrence creates it immediately plus the schedule', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;

		const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Weekly report {{date}}',
			description: 'Instance {{count}} of {{schedule_name}}',
			schedule: {
				preset: { kind: 'weekly', time: '09:00', weekday: 1 },
				timezone: 'Europe/London',
				require_all_closed: true
			}
		});
		expect(res.status()).toBe(201);
		const created = await body<CreateIssueResponse>(res);
		firstIssue = created;
		// {{date}} renders in the schedule's timezone (Europe/London here),
		// which differs from UTC around midnight.
		expect(created.title).toBe(`Weekly report ${todayIn('Europe/London')}`);
		expect(created.description).toBe('Instance 1 of Weekly report {{date}}');
		expect(created.schedule).toBeDefined();
		scheduleId = created.schedule!.id;
		expect(created.schedule!.name).toBe('Weekly report {{date}}');
		expect(created.schedule!.cron).toBe('0 9 * * 1');
		expect(created.schedule!.preset).toEqual({ kind: 'weekly', time: '09:00', weekday: 1 });
		expect(created.schedule!.timezone).toBe('Europe/London');
		expect(created.schedule!.require_all_closed).toBe(true);
		expect(created.schedule!.run_count).toBe(1);
		expect(created.schedule!.open_instances).toBe(1);
		expect(created.schedule!.next_run_at).toBeGreaterThan(Date.now());
		expect(created.scheduled_task_id).toBe(scheduleId);

		const projectSchedules = await body<ListResponse<Schedule>>(
			await api.get(`/api/v1/projects/${projectId}/schedules`)
		);
		expect(projectSchedules.items.map((s) => s.id)).toEqual([scheduleId]);
	});

	test('run-now respects the gate, naming the open instances', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/schedules/${scheduleId}/run`);
		expect(res.status()).toBe(422);
		const err = (await errorBody(res)).error;
		expect(err.code).toBe('schedule_blocked');
		expect(err.details?.open_instances).toEqual([
			{ issue_id: firstIssue.id, number: firstIssue.number, title: firstIssue.title }
		]);
	});

	test('run-now creates an instance once the blockers close', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		await api.post(`/api/v1/issues/${firstIssue.id}/transition`, { action: 'Abandon' });

		const res = await api.post(`/api/v1/schedules/${scheduleId}/run`);
		expect(res.status()).toBe(201);
		const instance = await body<IssueDetail>(res);
		expect(instance.title).toBe(`Weekly report ${todayIn('Europe/London')}`);
		expect(instance.description).toBe('Instance 2 of Weekly report {{date}}');
		expect(instance.scheduled_task_id).toBe(scheduleId);

		// Run-now instances are marked manual in the event payload.
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${instance.id}&type=issue.created`)
		);
		expect(events.items[0].payload.manual).toBe(true);

		// next_run_at is untouched by run-now, and run_count advanced.
		const schedule = await body<Schedule>(await api.get(`/api/v1/schedules/${scheduleId}`));
		expect(schedule.run_count).toBe(2);
	});

	test('editing the recurrence recomputes next_run_at; pause and resume work', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const before = await body<Schedule>(await api.get(`/api/v1/schedules/${scheduleId}`));

		const edited = await body<Schedule>(
			await api.patch(`/api/v1/schedules/${scheduleId}`, { cron: '30 6 * * *', timezone: 'UTC' })
		);
		expect(edited.cron).toBe('30 6 * * *');
		expect(edited.preset).toBeNull();
		expect(edited.timezone).toBe('UTC');
		expect(edited.next_run_at).not.toBe(before.next_run_at);
		const nextUtc = new Date(edited.next_run_at).toISOString();
		expect(nextUtc).toContain('T06:30:00');

		const paused = await body<Schedule>(
			await api.patch(`/api/v1/schedules/${scheduleId}`, { enabled: false })
		);
		expect(paused.enabled).toBe(false);

		const resumed = await body<Schedule>(
			await api.patch(`/api/v1/schedules/${scheduleId}`, { enabled: true })
		);
		expect(resumed.enabled).toBe(true);
		expect(resumed.next_run_at).toBeGreaterThan(Date.now());

		// The pause and resume are recorded as enabled toggles.
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?project=${projectId}&type=scheduled_task.updated`)
		);
		expect(events.items[0].payload.enabled).toEqual({ from: false, to: true });
		expect(events.items[1].payload.enabled).toEqual({ from: true, to: false });
	});

	test('cross-user access is a 404', async ({ request }) => {
		const bob = apiClient(request, BOB.apiKey);
		expect((await bob.get(`/api/v1/schedules/${scheduleId}`)).status()).toBe(404);
		expect((await bob.post(`/api/v1/schedules/${scheduleId}/run`)).status()).toBe(404);
	});

	test('deleting the schedule keeps its issues, unlinked', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		expect((await api.delete(`/api/v1/schedules/${scheduleId}`)).status()).toBe(204);
		expect((await api.get(`/api/v1/schedules/${scheduleId}`)).status()).toBe(404);

		const issues = await body<ListResponse<Issue>>(
			await api.get(`/api/v1/projects/${projectId}/issues?hide_done=0`)
		);
		expect(issues.items).toHaveLength(2);
		for (const issue of issues.items) {
			expect(issue.scheduled_task_id).toBeNull();
		}
		// History keeps the schedule's identity in the issue.created payloads.
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?project=${projectId}&type=issue.created`)
		);
		expect(events.items.every((e) => e.payload.scheduled_task_id === scheduleId)).toBe(true);
	});
});

test.describe('schedule validation', () => {
	let projectId: string;

	test.beforeAll(async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (
			await body<Project>(await api.post('/api/v1/projects', { name: `sched-val-${runId}` }))
		).id;
	});

	const create = (
		request: import('@playwright/test').APIRequestContext,
		schedule: unknown,
		title = 'T'
	) =>
		apiClient(request, ALICE.apiKey).post(`/api/v1/projects/${projectId}/issues`, {
			title,
			schedule
		});

	test('rejects an invalid cron expression', async ({ request }) => {
		const res = await create(request, { cron: 'not a cron' });
		expect(res.status()).toBe(422);
		expect((await errorBody(res)).error.code).toBe('invalid_cron');
	});

	test('rejects sub-hourly recurrences', async ({ request }) => {
		const res = await create(request, { cron: '*/15 * * * *' });
		expect(res.status()).toBe(422);
		const err = (await errorBody(res)).error;
		expect(err.code).toBe('invalid_cron');
		expect(err.message).toContain('more often than once per hour');
	});

	test('rejects an unknown timezone', async ({ request }) => {
		const res = await create(request, { cron: '0 9 * * *', timezone: 'Mars/Olympus' });
		expect(res.status()).toBe(422);
		expect((await errorBody(res)).error.code).toBe('invalid_timezone');
	});

	test('rejects both preset and cron, and neither', async ({ request }) => {
		const both = await create(request, {
			cron: '0 9 * * *',
			preset: { kind: 'daily', time: '09:00' }
		});
		expect(both.status()).toBe(422);
		expect((await errorBody(both)).error.code).toBe('invalid_recurrence');

		const neither = await create(request, {});
		expect(neither.status()).toBe(422);
		expect((await errorBody(neither)).error.code).toBe('invalid_recurrence');
	});

	test('accepts an hourly preset, compiling it to every-N-hours cron', async ({ request }) => {
		const res = await create(
			request,
			{ preset: { kind: 'hourly', every_hours: 6, minute: 30 }, timezone: 'UTC' },
			'Hourly check {{count}}'
		);
		expect(res.status()).toBe(201);
		const created = await body<CreateIssueResponse>(res);
		expect(created.schedule!.cron).toBe('30 */6 * * *');
		expect(created.schedule!.preset).toEqual({ kind: 'hourly', every_hours: 6, minute: 30 });
		// Next occurrence: within 6 hours, on a */6 hour boundary at :30 UTC.
		const next = new Date(created.schedule!.next_run_at);
		expect(created.schedule!.next_run_at - Date.now()).toBeLessThanOrEqual(6 * 3600_000);
		expect(next.getUTCHours() % 6).toBe(0);
		expect(next.getUTCMinutes()).toBe(30);
	});

	test('rejects an hourly preset with an out-of-range interval', async ({ request }) => {
		for (const every_hours of [0, 24]) {
			const res = await create(request, { preset: { kind: 'hourly', every_hours } });
			expect(res.status()).toBe(422);
			const err = (await errorBody(res)).error;
			expect(err.code).toBe('invalid_recurrence');
			expect(err.message).toContain('every_hours');
		}
	});

	test('rejects a duplicate schedule name within the project', async ({ request }) => {
		const first = await create(request, { preset: { kind: 'daily', time: '09:00' } }, 'Same name');
		expect(first.status()).toBe(201);
		const dup = await create(request, { preset: { kind: 'daily', time: '10:00' } }, 'Same name');
		expect(dup.status()).toBe(422);
		expect((await errorBody(dup)).error.code).toBe('duplicate_schedule_name');
	});
});

test.describe.serial('workflow deletion guard', () => {
	test('a workflow referenced by a schedule cannot be deleted', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const project = await body<Project>(
			await api.post('/api/v1/projects', { name: `sched-wf-${runId}` })
		);
		const workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `sched-wf-${runId}`,
				initial_state: 'Open',
				states: [
					{ name: 'Open', category: 'active' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [{ name: 'close', from: 'Open', to: 'Done' }]
			})
		);
		const created = await body<CreateIssueResponse>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: 'Scheduled on custom workflow',
				workflow_id: workflow.id,
				schedule: { preset: { kind: 'daily', time: '09:00' } }
			})
		);
		// Move the initial issue off the workflow so only the schedule holds it.
		await api.patch(`/api/v1/issues/${created.id}`, { workflow_id: 'wf_standard' });

		const res = await api.delete(`/api/v1/workflows/${workflow.id}`);
		expect(res.status()).toBe(422);
		const err = (await errorBody(res)).error;
		expect(err.code).toBe('workflow_in_use');
		expect(err.message).toContain('scheduled task');
		expect(err.details?.schedules).toEqual([
			{ id: created.schedule!.id, name: 'Scheduled on custom workflow' }
		]);

		// Deleting the schedule unblocks the workflow.
		await api.delete(`/api/v1/schedules/${created.schedule!.id}`);
		expect((await api.delete(`/api/v1/workflows/${workflow.id}`)).status()).toBe(204);
	});
});

test.describe('schedules in the web UI', () => {
	test('the project page lists schedules and issue rows carry the badge', async ({ browser }) => {
		const context = await browser.newContext();
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();

		await page.goto(`/projects/${SCHED.projectId}`);
		await expect(page.getByRole('heading', { name: 'Scheduled tasks' })).toBeVisible();
		await expect(page.getByText(SCHED.plainName, { exact: true })).toBeVisible();
		await expect(page.getByText(SCHED.gatedName, { exact: true })).toBeVisible();
		// The gated schedule's seeded open instance carries the repeat badge.
		await expect(
			page.getByRole('button', { name: `From schedule ${SCHED.gatedName}` })
		).toBeVisible();

		// The next-run line is phrased against the real next_run_at: a pending
		// run counts down, a past-due one says so. It must never read as an
		// imminent countdown while the timestamp is behind us (Tines/55).
		const api = apiClient(page.request, ALICE.apiKey);
		const schedule = await body<Schedule>(await api.get(`/api/v1/schedules/${SCHED.plainId}`));
		const line = page
			.locator('li', { hasText: SCHED.plainName })
			.locator('p', { hasText: /overdue|due now|^next in/ });
		if (schedule.next_run_at >= Date.now()) {
			await expect(line).toHaveText(/^next in (<1m|\d+[mhd]|\w{3} \d+, \d{4})$/);
		} else {
			await expect(line).toHaveText(/^(due now|\d+[mhd] overdue|overdue since .+)$/);
		}

		await context.close();
	});

	test('the New Issue modal shows the Repeat section with a live summary', async ({ browser }) => {
		const context = await browser.newContext();
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();

		await page.goto(`/projects/${SCHED.projectId}`);
		const dialog = page.getByRole('dialog', { name: /New issue/ });
		await clickUntil(page.getByRole('button', { name: 'New issue' }), async () => {
			await expect(dialog).toBeVisible({ timeout: 2_000 });
		});
		await dialog.getByRole('button', { name: 'Repeat' }).click();
		// Placeholders are only meaningful once there is a recurrence to render them.
		await expect(dialog.getByText('{{date}}', { exact: true })).toBeHidden();
		await page.locator('#issue-repeat-kind').selectOption('weekly');
		await expect(page.getByText(/Every \w+ at \d{2}:\d{2},.*— next:/)).toBeVisible();
		for (const token of [
			'{{date}}',
			'{{time}}',
			'{{datetime}}',
			'{{schedule_name}}',
			'{{count}}'
		]) {
			await expect(dialog.getByText(token, { exact: true })).toBeVisible();
		}
		await expect(page.getByRole('button', { name: 'Create issue + schedule' })).toBeVisible();

		await context.close();
	});
});
