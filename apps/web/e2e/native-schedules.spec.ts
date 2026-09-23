import type { APIRequestContext } from '@playwright/test';
import type { IssueDetail, Project, Schedule } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { apiClient, body, errorBody } from './helpers';

type ScheduleFixture = {
	api: ReturnType<typeof apiClient>;
	project: Project;
	initial: IssueDetail;
	schedule: Schedule;
};

async function fixture(
	request: APIRequestContext,
	name: string,
	options: { gated?: boolean } = {}
): Promise<ScheduleFixture> {
	const api = apiClient(request, ALICE.apiKey);
	const project = await body<Project>(await api.post('/api/v1/projects', { name }));
	const initial = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${project.id}/issues`, {
			title: `${name} {{count}}`,
			description: `${name} {{schedule_name}}`,
			schedule: {
				preset: { kind: 'daily', time: '09:00' },
				...(options.gated ? { require_all_closed: true } : {})
			}
		})
	);
	return { api, project, initial, schedule: initial.schedule! };
}

async function closeInitial(fixture: ScheduleFixture): Promise<void> {
	const response = await fixture.api.post(`/api/v1/issues/${fixture.initial.id}/transition`, {
		action: 'Abandon'
	});
	expect(response.ok()).toBe(true);
}

function due(scheduleId: string): number {
	const timestamp = Date.now() - 60_000;
	d1(
		`UPDATE scheduled_task SET next_run_at=${timestamp}, enabled=1 WHERE id=${sqlLiteral(scheduleId)}`
	);
	return timestamp;
}

function scheduleRows(scheduleId: string) {
	return d1<{
		run_count: number;
		last_run_at: number | null;
		next_run_at: number;
		definition_revision: number;
	}>(
		`SELECT run_count,last_run_at,next_run_at,definition_revision FROM scheduled_task WHERE id=${sqlLiteral(scheduleId)}`
	);
}

function issueRows(scheduleId: string) {
	return d1<{ id: string; title: string }>(
		`SELECT id,title FROM issue WHERE scheduled_task_id=${sqlLiteral(scheduleId)} ORDER BY number`
	);
}

function eventRows(projectId: string, type?: string) {
	const typeFilter = type ? ` AND type=${sqlLiteral(type)}` : '';
	return d1<{ id: string; type: string; issue_id: string | null; payload: string }>(
		`SELECT id,type,issue_id,payload FROM event WHERE project_id=${sqlLiteral(projectId)}${typeFilter} ORDER BY created_at,id`
	);
}

async function expectSingleCreatedInstance(fixture: ScheduleFixture, expectedCount = 2) {
	const issues = issueRows(fixture.schedule.id);
	const created = eventRows(fixture.project.id, 'issue.created');
	const rows = scheduleRows(fixture.schedule.id);
	expect(issues).toHaveLength(expectedCount);
	expect(created).toHaveLength(expectedCount);
	expect(rows).toHaveLength(1);
	expect(rows[0].run_count).toBe(expectedCount);
	return JSON.parse(created.at(-1)!.payload) as Record<string, unknown>;
}

test.describe.serial('native D1 scheduled execution fences', () => {
	test('manual/manual commits one gated instance in either request order', async ({
		request,
		uniqueName
	}) => {
		test.setTimeout(120_000);
		for (const reverse of [false, true]) {
			const scheduleFixture = await fixture(request, uniqueName(`native-manual-${reverse}`), {
				gated: true
			});
			await closeInitial(scheduleFixture);
			const calls = [
				() => scheduleFixture.api.post(`/api/v1/schedules/${scheduleFixture.schedule.id}/run`),
				() => scheduleFixture.api.post(`/api/v1/schedules/${scheduleFixture.schedule.id}/run`)
			];
			const responses = await Promise.all(
				(reverse ? calls.reverse() : calls).map((call) => call())
			);
			expect(responses.map((response) => response.status()).sort()).toEqual([201, 422]);
			const loser = responses.find((response) => response.status() === 422)!;
			expect((await errorBody(loser)).error.code).toBe('schedule_blocked');
			const payload = await expectSingleCreatedInstance(scheduleFixture);
			expect(payload.manual).toBe(true);
		}
	});

	test('manual/cron and cron/cron share one native due occurrence', async ({
		request,
		uniqueName
	}) => {
		test.setTimeout(120_000);
		for (const mode of ['manual-cron', 'cron-cron'] as const) {
			for (const reverse of [false, true]) {
				const scheduleFixture = await fixture(request, uniqueName(`native-${mode}-${reverse}`), {
					gated: true
				});
				await closeInitial(scheduleFixture);
				const occurrence = due(scheduleFixture.schedule.id);
				const calls =
					mode === 'manual-cron'
						? [
								() =>
									scheduleFixture.api.post(`/api/v1/schedules/${scheduleFixture.schedule.id}/run`),
								() => request.get('/__scheduled?cron=*+*+*+*+*')
							]
						: [
								() => request.get('/__scheduled?cron=*+*+*+*+*'),
								() => request.get('/__scheduled?cron=*+*+*+*+*')
							];
				const responses = await Promise.all(
					(reverse ? calls.reverse() : calls).map((call) => call())
				);
				if (mode === 'manual-cron') {
					const manualResponse = responses.find((response) =>
						response.url().includes('/schedules/')
					)!;
					const cronResponse = responses.find((response) =>
						response.url().includes('/__scheduled')
					)!;
					expect(cronResponse.status()).toBe(200);
					expect([201, 422]).toContain(manualResponse.status());
					if (manualResponse.status() === 422) {
						expect((await errorBody(manualResponse)).error.code).toBe('schedule_blocked');
					}
				} else {
					expect(responses.every((response) => response.status() === 200)).toBe(true);
				}
				await expectSingleCreatedInstance(scheduleFixture);
				const rows = scheduleRows(scheduleFixture.schedule.id);
				expect(rows[0].next_run_at).toBeGreaterThan(occurrence);
				if (mode === 'manual-cron') {
					const skips = eventRows(scheduleFixture.project.id, 'scheduled_task.skipped');
					// The cron loser records the established skip, while a manual loser
					// reports schedule_blocked without consuming the manual cursor.
					expect(skips.length).toBeLessThanOrEqual(1);
				}
			}
		}
	});

	test('a gated due occurrence records the four-field skip blocker and advances', async ({
		request,
		uniqueName
	}) => {
		const scheduleFixture = await fixture(request, uniqueName('native-skip'), { gated: true });
		const occurrence = due(scheduleFixture.schedule.id);
		const before = scheduleRows(scheduleFixture.schedule.id)[0];
		await request.get('/__scheduled?cron=*+*+*+*+*');
		expect(issueRows(scheduleFixture.schedule.id)).toHaveLength(1);
		const skips = eventRows(scheduleFixture.project.id, 'scheduled_task.skipped');
		expect(skips).toHaveLength(1);
		expect(JSON.parse(skips[0].payload)).toEqual({
			schedule_id: scheduleFixture.schedule.id,
			name: scheduleFixture.schedule.name,
			occurrence,
			blocking: [
				{
					issue_id: scheduleFixture.initial.id,
					project_id: scheduleFixture.project.id,
					project_name: scheduleFixture.project.name,
					number: scheduleFixture.initial.number
				}
			]
		});
		const rows = scheduleRows(scheduleFixture.schedule.id);
		expect(rows[0]).toMatchObject({ run_count: 1, last_run_at: before.last_run_at });
		expect(rows[0].next_run_at).toBeGreaterThan(occurrence);
	});

	test('pause and archive committed before issuance prevent cron and manual work', async ({
		request,
		uniqueName
	}) => {
		const paused = await fixture(request, uniqueName('native-paused'));
		const pausedDue = due(paused.schedule.id);
		await paused.api.patch(`/api/v1/schedules/${paused.schedule.id}`, { enabled: false });
		await request.get('/__scheduled?cron=*+*+*+*+*');
		expect(issueRows(paused.schedule.id)).toHaveLength(1);
		expect(eventRows(paused.project.id, 'scheduled_task.skipped')).toEqual([]);
		expect(scheduleRows(paused.schedule.id)[0]).toMatchObject({
			run_count: 1,
			next_run_at: pausedDue
		});
		await closeInitial(paused);
		const manual = await paused.api.post(`/api/v1/schedules/${paused.schedule.id}/run`);
		expect(manual.status()).toBe(201);
		expect((await expectSingleCreatedInstance(paused)).manual).toBe(true);

		const archived = await fixture(request, uniqueName('native-archived'));
		await closeInitial(archived);
		due(archived.schedule.id);
		expect((await archived.api.post(`/api/v1/projects/${archived.project.id}/archive`)).ok()).toBe(
			true
		);
		const [manualResponse, cronResponse] = await Promise.all([
			archived.api.post(`/api/v1/schedules/${archived.schedule.id}/run`),
			request.get('/__scheduled?cron=*+*+*+*+*')
		]);
		expect(manualResponse.status()).toBe(422);
		expect((await errorBody(manualResponse)).error.code).toBe('project_archived');
		expect(cronResponse.ok()).toBe(true);
		expect(issueRows(archived.schedule.id)).toHaveLength(1);
		expect(eventRows(archived.project.id, 'issue.created')).toHaveLength(1);
		expect(eventRows(archived.project.id, 'scheduled_task.skipped')).toEqual([]);
		expect(scheduleRows(archived.schedule.id)[0]).toMatchObject({
			run_count: 1
		});
	});

	test('native D1 rolls back issue, address, event, and bookkeeping on a late failure', async ({
		request,
		uniqueName
	}) => {
		const scheduleFixture = await fixture(request, uniqueName('native-rollback'));
		await closeInitial(scheduleFixture);
		const beforeAddress = d1<{ n: number }>(
			`SELECT COUNT(*) AS n FROM issue_address WHERE project_id=${sqlLiteral(scheduleFixture.project.id)}`
		)[0].n;
		const trigger = `reject_native_schedule_${Date.now().toString(36)}`;
		d1(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF run_count ON scheduled_task
			WHEN NEW.id=${sqlLiteral(scheduleFixture.schedule.id)}
			BEGIN SELECT RAISE(ABORT, 'native schedule bookkeeping failure'); END`);
		try {
			const response = await scheduleFixture.api.post(
				`/api/v1/schedules/${scheduleFixture.schedule.id}/run`
			);
			expect(response.status()).toBe(500);
			expect(issueRows(scheduleFixture.schedule.id)).toHaveLength(1);
			expect(eventRows(scheduleFixture.project.id, 'issue.created')).toHaveLength(1);
			expect(
				d1<{ n: number }>(
					`SELECT COUNT(*) AS n FROM issue_address WHERE project_id=${sqlLiteral(scheduleFixture.project.id)}`
				)[0].n
			).toBe(beforeAddress);
			expect(scheduleRows(scheduleFixture.schedule.id)[0]).toMatchObject({
				run_count: 1
			});
		} finally {
			d1(`DROP TRIGGER IF EXISTS ${trigger}`);
		}
	});

	test('native D1 rolls back a gated skip after event insertion when cursor advancement fails', async ({
		request,
		uniqueName
	}) => {
		const scheduleFixture = await fixture(request, uniqueName('native-skip-rollback'), {
			gated: true
		});
		const occurrence = due(scheduleFixture.schedule.id);
		const trigger = `reject_native_schedule_skip_cursor_${Date.now().toString(36)}`;
		d1(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF next_run_at ON scheduled_task
			WHEN NEW.id=${sqlLiteral(scheduleFixture.schedule.id)} AND NEW.next_run_at <> OLD.next_run_at
			BEGIN SELECT RAISE(ABORT, 'native schedule skip cursor failure'); END`);
		try {
			const response = await request.get('/__scheduled?cron=*+*+*+*+*');
			expect(response.ok()).toBe(true);
			expect(eventRows(scheduleFixture.project.id, 'scheduled_task.skipped')).toEqual([]);
			expect(issueRows(scheduleFixture.schedule.id)).toHaveLength(1);
			expect(scheduleRows(scheduleFixture.schedule.id)[0]).toMatchObject({
				run_count: 1,
				next_run_at: occurrence
			});
		} finally {
			d1(`DROP TRIGGER IF EXISTS ${trigger}`);
		}
	});
});
