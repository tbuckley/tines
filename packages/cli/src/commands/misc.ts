/**
 * `tines time` and `tines events` — the two commands too small to own a module.
 * They register separately because root help lists commands in registration
 * order, and `time` comes first while `events` comes last.
 */
import {
	client,
	printJson,
	printList,
	resolveIssue,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { timestamp } from '../format.js';
import { actorLabel, type TinesEvent } from '@tines/shared';
import type { Command } from 'commander';

function eventSummary(ev: TinesEvent): string {
	const p = ev.payload as Record<string, unknown>;
	const issue = ev.issue_ref ? `${ev.issue_ref.project_name}/#${ev.issue_ref.number}` : null;
	switch (ev.type) {
		case 'issue.created':
			return `created ${issue}: ${p.title}${p.scheduled_task_name ? ` (via schedule "${p.scheduled_task_name}")` : ''}`;
		case 'issue.updated':
			return `updated ${issue} (${(p.changed as string[])?.join(', ')})`;
		case 'issue.transitioned':
			return `${p.action ? `"${p.action}" on` : 'moved'} ${issue}: ${p.from_state_name} → ${p.to_state_name}`;
		case 'issue.commented':
			return `commented on ${issue}`;
		case 'project.created':
		case 'project.updated':
		case 'project.deleted':
			return `${ev.type.split('.')[1]} project "${p.name ?? ev.project_name}"`;
		case 'workflow.created':
		case 'workflow.updated':
		case 'workflow.deleted':
			return `${ev.type.split('.')[1]} workflow "${p.name}"`;
		case 'api_key.created':
			return `created API key "${p.name}"`;
		case 'api_key.revoked':
			return `revoked API key "${p.name}"`;
		case 'scheduled_task.created':
		case 'scheduled_task.updated':
		case 'scheduled_task.deleted':
			return `${ev.type.split('.')[1]} schedule "${p.name}"`;
		case 'context.created':
		case 'context.updated':
		case 'context.deleted': {
			const scope = p.scope as { label?: string } | undefined;
			const verb = ev.type.split('.')[1];
			return `${verb} ${p.kind} "${p.name}"${scope?.label ? ` [${scope.label}]` : ''}`;
		}
		case 'scheduled_task.skipped': {
			const blocking = Array.isArray(p.blocking) ? p.blocking.length : 0;
			return `skipped schedule "${p.name}" (${blocking} open instance${blocking === 1 ? '' : 's'})`;
		}
		case 'runner.registered':
		case 'runner.updated':
		case 'runner.removed':
			return `${ev.type.split('.')[1]} runner "${p.name}"`;
		case 'runner.errored':
			return `runner "${p.runner_name}" failed to launch (${p.consecutive_failures} consecutive): ${p.error}`;
		case 'agent_run.started':
			return `run started on ${issue} via ${p.runner_name} (${p.tier}${p.model ? ` → ${p.model}` : ''})`;
		case 'agent_run.ended':
			return `run ${p.status} on ${issue} via ${p.runner_name}${p.outcome ? ` — ${p.outcome}` : ''}`;
		case 'issue.parked':
			return `parked ${issue} after ${p.attempt_count} strikes — needs attention`;
		case 'issue.resumed':
			return `resumed ${issue} (attempt count reset)`;
		case 'routing_rule.created':
		case 'routing_rule.updated':
		case 'routing_rule.deleted':
			return `${ev.type.split('.')[1]} the ${p.scope_label} routing rule`;
		case 'settings.updated':
			return `updated supervisor settings (${(p.changed as string[])?.join(', ') || 'no changes'})`;
		default:
			return ev.type;
	}
}

export function registerTime(program: Command): void {
	withCommon(program.command('time').description('Fetch the current time from the Tines API')).action(
		async (opts: CommonOpts) => {
			const result = await client(opts).getTime();
			if (opts.json) printJson(result);
			else console.log(`Server time: ${result.time} (unix ${result.unix})`);
		}
	);
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
	).action(async (opts: ListOpts & { issue?: string; project?: string; type?: string }) => {
		const api = client(opts);
		const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
		const res = await api.listEvents({
			issue: issueId,
			project: opts.project,
			type: opts.type,
			limit: opts.limit,
			cursor: opts.cursor
		});
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log('no events');
			table([
				['WHEN', 'ACTOR', 'EVENT'],
				...items.map((ev) => [timestamp(ev.created_at), actorLabel(ev.actor), eventSummary(ev)])
			]);
		});
	});
}
