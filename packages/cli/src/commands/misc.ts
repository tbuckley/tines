/**
 * `tines time` and `tines events` — the two commands too small to own a module.
 * They register separately because root help lists commands in registration
 * order, and `time` comes first while `events` comes last.
 */
import {
	client,
	fetchList,
	printJson,
	printList,
	resolveIssue,
	resolveStateFlag,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { timestamp } from '../format.js';
import { displayActor, eventSummary } from '@tines/shared';
import type { Command } from 'commander';

export function registerTime(program: Command): void {
	withCommon(
		program.command('time').description('Fetch the current time from the Tines API')
	).action(async (opts: CommonOpts) => {
		const result = await client(opts).getTime();
		if (opts.json) printJson(result);
		else console.log(`Server time: ${result.time} (unix ${result.unix})`);
	});
}

export function registerEvents(program: Command): void {
	const events = program.command('events').description('Read the activity log');

	withList(
		events
			.command('list')
			.description('List activity events, newest first')
			.option('-i, --issue <ref>', 'filter to one issue (<project>/<number>)')
			.option('-p, --project <name>', 'filter by project name or id')
			.option('-t, --type <type>', 'filter by event type (e.g. issue.transitioned)')
			.option('--since <time>', 'inclusive lower bound (ISO 8601 or epoch ms)')
			.option('--until <time>', 'exclusive upper bound (ISO 8601 or epoch ms)')
			.option('--state <workflow/state>', 'events referencing a workflow state')
	).action(async (opts: ListOpts & { issue?: string; project?: string; type?: string; since?: string; until?: string; state?: string }) => {
		const api = client(opts);
		const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
		const stateId = opts.state ? (await resolveStateFlag(api, opts.state)).state.id : undefined;
		const res = await fetchList(opts, (page) =>
			api.listEvents({
				issue: issueId,
				project: opts.project,
				type: opts.type,
				since: opts.since,
				until: opts.until,
				state: stateId,
				...page
			})
		);
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log('no events');
			table([
				['WHEN', 'ACTOR', 'EVENT'],
				...items.map((ev) => [timestamp(ev.created_at), displayActor(ev), eventSummary(ev)])
			]);
		});
	});
}
