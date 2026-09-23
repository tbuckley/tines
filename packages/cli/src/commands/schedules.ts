/** `tines schedules` — scheduled tasks, addressed as <project>/<name>. */
import { createInterface } from 'node:readline/promises';
import { BODY_VALUE_HELP, readBodyValue } from '../body-value.js';
import {
	client,
	die,
	fetchList,
	printJson,
	printList,
	resolveProject,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { recurrenceLabel, scheduleRef, timestamp } from '../format.js';
import { buildRecurrence, type RecurrenceOpts } from '../recurrence-flags.js';
import { parseScheduleRef } from '../refs.js';
import {
	listAll,
	type ApiClient,
	type Schedule,
	type SchedulePreset,
	type UpdateScheduleRequest
} from '@tines/shared';
import type { Command } from 'commander';

async function resolveSchedule(api: ApiClient, ref: string): Promise<Schedule> {
	const { project, name } = parseScheduleRef(ref);
	const proj = await resolveProject(api, project);
	const items = await listAll((page) => api.listProjectSchedules(proj.id, page));
	const found = items.find((s) => s.name === name) ?? items.find((s) => s.id === name);
	if (!found) {
		die(
			`no schedule "${name}" in project "${proj.name}" (have: ${items.map((s) => s.name).join(', ') || 'none'})`
		);
	}
	return found;
}

function printScheduleDetail(s: Schedule): void {
	const shared = s as Schedule & {
		project?: { name: string; owner: { name: string } };
		recurrence?: { cron: string; enabled: boolean; timezone: string };
		workflow?: { name: string; start_state_name: string };
	};
	if (shared.project) {
		console.log(`${shared.project.name}/${shared.name}  [${shared.id}]`);
		console.log(`owner: ${shared.project.owner.name}  workflow: ${shared.workflow?.name}`);
		console.log(`cron: ${shared.recurrence?.cron}  timezone: ${shared.recurrence?.timezone}`);
		console.log(
			`status: ${shared.recurrence?.enabled ? 'enabled' : 'paused'}  start state: ${shared.workflow?.start_state_name}`
		);
		console.log(`\ntitle template: ${shared.title_template}`);
		if (shared.description_template)
			console.log(`description template:\n${shared.description_template}`);
		console.log('\nThis shared schedule is read only in the current release.');
		return;
	}
	console.log(`${scheduleRef(s)}  [${s.id}]${s.enabled ? '' : '  (paused)'}`);
	console.log(`${recurrenceLabel(s)} (cron "${s.cron}")`);
	console.log(
		`gate: ${s.require_all_closed ? 'only create when previous instances are closed' : 'off'}  workflow: ${s.workflow_name}  start state: ${s.state_name ?? '(initial)'}`
	);
	console.log(
		`next run: ${s.enabled ? timestamp(s.next_run_at) : '(paused)'}  last run: ${s.last_run_at ? timestamp(s.last_run_at) : 'never'}  runs: ${s.run_count}  open instances: ${s.open_instances}`
	);
	if (s.my_future_permission)
		console.log(
			`my agents on future issues: ${s.my_future_permission.value === 'on' ? 'on' : 'off (default)'}  permission epoch: ${s.my_future_permission.epoch}  (change in the browser)`
		);
	console.log(`\ntitle template: ${s.title_template}`);
	if (s.description_template) {
		console.log('description template:');
		for (const line of s.description_template.split('\n')) console.log(`  ${line}`);
	}
}

export function register(program: Command): void {
	const schedules = program
		.command('schedules')
		.description('Manage scheduled tasks (addressed as <project>/<name>)');

	withList(
		schedules
			.command('list')
			.description('List scheduled tasks (hides paused schedules unless --all)')
			.option('-p, --project <name>', 'filter by project name or id')
			.option('-a, --all', 'include paused schedules')
	).action(async (opts: ListOpts & { project?: string; all?: boolean }) => {
		const api = client(opts);
		const res = await fetchList(opts, (page) =>
			api.listSchedules({
				project: opts.project,
				enabled: opts.all ? undefined : true,
				...page
			})
		);
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log('no schedules');
			table([
				['NAME', 'RECURRENCE', 'NEXT RUN', 'LAST RUN', 'OPEN', 'MY FUTURE', ''],
				...items.map((s) => {
					const shared = s as Schedule & {
						project?: { name: string };
						recurrence?: { cron: string; enabled: boolean };
					};
					return shared.project
						? [
								`${shared.project.name}/${shared.name}`,
								shared.recurrence?.cron ?? '—',
								'—',
								'—',
								'—',
								shared.my_future_permission?.value ?? 'unset',
								shared.recurrence?.enabled ? '' : '(paused)'
							]
						: [
								scheduleRef(s),
								recurrenceLabel(s),
								s.enabled ? timestamp(s.next_run_at) : '—',
								s.last_run_at ? timestamp(s.last_run_at) : 'never',
								String(s.open_instances),
								s.my_future_permission
									? s.my_future_permission.value === 'on'
										? 'on'
										: 'off'
									: '—',
								s.enabled ? '' : '(paused)'
							];
				})
			]);
		});
	});

	withCommon(
		schedules
			.command('show <ref>')
			.description('Show a schedule (<project>/<name>): config, next/last run, recent instances')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		if (opts.json) return printJson(schedule);
		printScheduleDetail(schedule);
		const { items } = await api.listIssues({ schedule: schedule.id, limit: 10 });
		if (items.length > 0) {
			console.log(`\nrecent instances:`);
			table(
				items.map((i) => [
					`  ${i.project_name}/${i.number}`,
					i.title,
					i.state.name,
					timestamp(i.created_at)
				])
			);
		}
	});

	withCommon(
		schedules
			.command('edit <ref>')
			.description(
				'Edit a schedule: templates, workflow, start state, recurrence, timezone, gate, or name'
			)
			.option('-t, --title <template>', 'set the title template')
			.option(
				'-d, --description <markdown>',
				`set the description template (Markdown) — ${BODY_VALUE_HELP}`
			)
			.option(
				'-w, --workflow <id-or-name>',
				'move future instances onto another workflow (resets the start state to its initial state unless --state is also given)'
			)
			.option(
				'-s, --state <id-or-name>',
				"start state for future instances (the workflow's initial state = the default)"
			)
			.option(
				'--every <preset>',
				'repeat hourly (or every N hours: "6h"), daily, weekly, or monthly'
			)
			.option(
				'--at <when>',
				'preset time of day HH:MM (default 09:00); for hourly, the minute past the hour :MM (default :00)'
			)
			.option('--on <when>', 'weekday (weekly) or day of month (monthly)')
			.option('--cron <expr>', '5-field cron expression (alternative to --every/--at/--on)')
			.option('--tz <iana>', 'set the schedule timezone')
			.option('--if-closed', 'only create a new instance when all previous instances are closed')
			.option('--no-if-closed', 'clear the only-when-closed gate')
			.option('--name <new-name>', 'rename the schedule')
	).action(
		async (
			ref: string,
			opts: CommonOpts &
				RecurrenceOpts & {
					title?: string;
					description?: string;
					workflow?: string;
					state?: string;
					ifClosed?: boolean;
					name?: string;
				}
		) => {
			const descriptionTemplate =
				opts.description !== undefined ? readBodyValue(opts.description) : undefined;
			const api = client(opts);
			const schedule = await resolveSchedule(api, ref);
			const body: UpdateScheduleRequest = {};
			if (opts.title !== undefined) body.title_template = opts.title;
			if (descriptionTemplate !== undefined) body.description_template = descriptionTemplate;
			if (opts.workflow !== undefined)
				body.workflow_id = (await resolveWorkflow(api, opts.workflow)).id;
			if (opts.state !== undefined) body.state = opts.state;
			const recurrence = buildRecurrence(opts);
			if (recurrence?.preset) body.preset = recurrence.preset as SchedulePreset;
			if (recurrence?.cron !== undefined) body.cron = recurrence.cron;
			if (opts.tz !== undefined) body.timezone = opts.tz;
			if (opts.ifClosed !== undefined) body.require_all_closed = opts.ifClosed;
			if (opts.name !== undefined) body.name = opts.name;
			if (Object.keys(body).length === 0) {
				die(
					'nothing to update: pass --title, --description, --workflow, --state, --every/--at/--on, --cron, --tz, --[no-]if-closed, and/or --name'
				);
			}
			const updated = await api.updateSchedule(schedule.id, body);
			if (opts.json) return printJson(updated);
			console.log(`updated schedule "${scheduleRef(updated)}"\n`);
			printScheduleDetail(updated);
		}
	);

	withCommon(
		schedules.command('pause <ref>').description('Pause a schedule (keeps config and history)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const updated = await api.updateSchedule(schedule.id, { enabled: false });
		if (opts.json) return printJson(updated);
		console.log(`paused schedule "${scheduleRef(updated)}"`);
	});

	withCommon(
		schedules
			.command('resume <ref>')
			.description('Resume a paused schedule (recomputes the next occurrence from now)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const updated = await api.updateSchedule(schedule.id, { enabled: true });
		if (opts.json) return printJson(updated);
		console.log(
			`resumed schedule "${scheduleRef(updated)}" — next run ${timestamp(updated.next_run_at)}`
		);
	});

	withCommon(
		schedules
			.command('run <ref>')
			.description('Create an instance now (respects the only-when-closed gate)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const issue = await api.runSchedule(schedule.id);
		if (opts.json) return printJson(issue);
		console.log(
			`created ${issue.project_name}/#${issue.number} "${issue.title}" in state "${issue.state.name}"`
		);
	});

	withCommon(
		schedules
			.command('delete <ref>')
			.description('Delete a schedule (existing issues are kept)')
			.option('-y, --yes', 'skip the confirmation prompt')
	).action(async (ref: string, opts: CommonOpts & { yes?: boolean }) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		if (!opts.yes) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			const answer = await rl.question(
				`Delete schedule "${scheduleRef(schedule)}"? Its ${schedule.run_count} existing issue${schedule.run_count === 1 ? '' : 's'} will be kept. [y/N] `
			);
			rl.close();
			if (!/^y(es)?$/i.test(answer.trim())) die('aborted');
		}
		await api.deleteSchedule(schedule.id);
		console.log(`deleted schedule "${scheduleRef(schedule)}" (issues kept)`);
	});
}
