/** `tines supervisor` — the automation kill switch, quota policy, and attempt limit. */
import {
	client,
	collect,
	die,
	printJson,
	resolveStateFlag,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import { hoursLabel, quotaLabel, runnerStatusLabel } from '../format.js';
import { listAll, utilizationLabel, type QueueGroup } from '@tines/shared';
import type { Command } from 'commander';

/** One printed block per `(verdict, runner)`, the way the Agents tab groups them. */
interface QueueBlock {
	verdict: QueueGroup['verdict'];
	runnerName: string | null;
	binding: QueueGroup['binding'];
	count: number;
	groups: QueueGroup[];
}

export function queueBlocks(groups: QueueGroup[]): QueueBlock[] {
	const byKey = new Map<string, QueueBlock>();
	for (const g of groups) {
		const key = `${g.verdict}|${g.runner_id ?? ''}`;
		const seen = byKey.get(key);
		if (seen) {
			seen.count += g.count;
			seen.groups.push(g);
			seen.binding ??= g.binding;
		} else {
			byKey.set(key, {
				verdict: g.verdict,
				runnerName: g.runner_name,
				binding: g.binding,
				count: g.count,
				groups: [g]
			});
		}
	}
	return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export function queueHeadline(block: QueueBlock): string {
	const runner = block.runnerName ?? 'the routed runner';
	switch (block.verdict) {
		case 'ok':
			return 'dispatching next pass';
		case 'at_capacity':
			return block.binding?.kind === 'max_concurrent'
				? `at capacity on ${runner} (${block.binding.current}/${block.binding.limit})`
				: `at capacity on ${runner}`;
		case 'quota_exhausted':
			if (block.binding?.kind === 'global_cap')
				return `global cap reached (${block.binding.current}/${block.binding.limit})`;
			if (block.binding?.kind === 'state_roster')
				return `roster limit reached (${block.binding.current}/${block.binding.limit})`;
			return 'quota exhausted';
		case 'offline':
			return `${runner} offline`;
		case 'paused':
			return `${runner} paused`;
		case 'draining':
			return `${runner} draining`;
		case 'backing_off':
			return `${runner} backing off`;
		case 'no_rule':
			return 'no matching routing rule';
		case 'no_targets':
			return 'the matching rule has no targets';
		case 'ambiguous_rule':
			return 'two routing rules tie';
		case 'pin_missing':
			return 'pinned to a runner that is gone';
		case 'automation_off':
			return 'automation is off';
		case 'parked':
			return 'parked';
	}
}

/**
 * The one command or knob that unblocks a block; null when nothing to do but
 * wait.
 *
 * Every `tines …` here has to be a command that actually exists and actually
 * takes the flags named — an operator pastes these. `queue-fix.test.ts` walks
 * the real command tree and fails on any citation that does not resolve, so a
 * renamed subcommand or dropped flag reds here rather than printing a help
 * dump at whoever is trying to unblock their fleet.
 */
export function queueFix(block: QueueBlock): string | null {
	const runner = block.runnerName ?? 'the routed runner';
	switch (block.verdict) {
		case 'at_capacity':
			// No CLI command sets a runner's server-side max_concurrent: the daemon's
			// flag rides along on every poll, so restarting it is the CLI remedy.
			return `raise the cap on ${runner} — restart its daemon with tines runner daemon --max-concurrent N, or edit the runner on the Agents page`;
		case 'quota_exhausted':
			return block.binding?.kind === 'state_roster'
				? 'raise the roster limit — tines supervisor quota roster --default <n> --state <workflow>/<state>=<n> (this replaces the whole roster, so restate every override you keep)'
				: 'raise the cap — tines supervisor quota global <n> — or switch to a per-state roster with tines supervisor quota roster';
		case 'offline':
			return `start the daemon on that machine — tines runner daemon`;
		case 'paused':
			return `tines runners resume ${runner}`;
		case 'no_rule':
			return 'add a routing rule for that state — tines routing set <runner> --state <workflow>/<state>';
		case 'no_targets':
		case 'ambiguous_rule':
			return 'tines routing list, then edit the rule';
		case 'pin_missing':
			return 'clear the pin on those issues';
		case 'automation_off':
			return 'tines supervisor enable';
		case 'backing_off':
			return 'retries automatically; check the daemon log if it keeps failing';
		default:
			return null;
	}
}

export function register(program: Command): void {
	const supervisor = program
		.command('supervisor')
		.description('The automation kill switch, quota policy, and attempt limit');

	withCommon(
		supervisor
			.command('status')
			.description('One-screen overview: kill switch, quota, utilization, runners')
	).action(async (opts: CommonOpts) => {
		const api = client(opts);
		const [settings, runnersRes, workflows, activeRunItems, queue] = await Promise.all([
			api.getSupervisorSettings(),
			api.listRunners(),
			api.listWorkflows(),
			listAll((page) => api.listRuns({ active: true, ...page })),
			api.getSupervisorQueue()
		]);
		if (opts.json) {
			return printJson({
				settings,
				runners: runnersRes.items,
				active_runs: activeRunItems,
				queue
			});
		}
		const stateNames = new Map<string, string>();
		for (const wf of workflows.items) {
			for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
		}
		console.log(
			`automation: ${settings.enabled ? 'ON' : 'OFF (kill switch — nothing dispatches)'}`
		);
		console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
		console.log(
			`utilization: ${utilizationLabel(settings.quota, activeRunItems, (id) => stateNames.get(id) ?? id)}`
		);
		console.log(`attempt limit: ${settings.attempt_limit} strikes, then the issue parks`);
		// The Now row (Tines/256): what is waiting, why, and the one command or
		// knob that unblocks it. Refs print under --json only — the point of the
		// text block is the reason, not the backlog.
		if (queue.waiting === 0) {
			console.log('waiting: nothing');
		} else {
			console.log(`waiting: ${queue.waiting} ${queue.waiting === 1 ? 'issue' : 'issues'}`);
			for (const block of queueBlocks(queue.groups)) {
				const states = block.groups
					.map(
						(g) =>
							`${stateNames.get(g.state_id) ?? g.state_name} ${g.count} (oldest ${hoursLabel(g.oldest_entered_at)})`
					)
					.join(' · ');
				console.log(`  ${queueHeadline(block)}: ${states}`);
				const fix = queueFix(block);
				if (fix) console.log(`    fix: ${fix}`);
			}
		}
		console.log(
			queue.parked.count === 0
				? 'parked: none'
				: `parked: ${queue.parked.count}, oldest ${hoursLabel(queue.parked.oldest_entered_at ?? Date.now())}`
		);
		if (queue.awaiting_human.count > 0) {
			console.log(
				`awaiting you: ${queue.awaiting_human.count} issues, oldest ${hoursLabel(queue.awaiting_human.oldest_entered_at ?? Date.now())}`
			);
		}
		if (runnersRes.items.length === 0) {
			console.log('runners: none');
		} else {
			console.log('runners:');
			table(
				runnersRes.items.map((r) => [
					`  ${r.name}`,
					r.type,
					runnerStatusLabel(r),
					`${r.active_runs}/${r.max_concurrent}`
				])
			);
		}
	});

	withCommon(
		supervisor.command('enable').description('Arm automation (the kill switch on)')
	).action(async (opts: CommonOpts) => {
		const settings = await client(opts).updateSupervisorSettings({ enabled: true });
		if (opts.json) return printJson(settings);
		console.log('automation is ON — eligible issues with a matching rule will dispatch');
	});

	withCommon(
		supervisor.command('disable').description('Pause all automation at once (the kill switch off)')
	).action(async (opts: CommonOpts) => {
		const settings = await client(opts).updateSupervisorSettings({ enabled: false });
		if (opts.json) return printJson(settings);
		console.log('automation is OFF — nothing new dispatches until re-enabled');
	});

	const quota = supervisor.command('quota').description('Pick and configure the quota policy');

	withCommon(
		quota
			.command('global <n>')
			.description('Use the global cap: at most <n> concurrent runs in total')
	).action(async (n: string, opts: CommonOpts) => {
		const limit = Number.parseInt(n, 10);
		const settings = await client(opts).updateSupervisorSettings({
			quota: { type: 'global_cap', limit }
		});
		if (opts.json) return printJson(settings);
		console.log(quotaLabel(settings.quota));
	});

	withCommon(
		quota
			.command('roster')
			.description('Use the per-state roster: at most N concurrent runs per workflow state')
			.requiredOption('--default <n>', 'limit for states without an override', (v) =>
				Number.parseInt(v, 10)
			)
			.option(
				'--state <workflow/state=n>',
				'per-state override (repeatable), counted by the state a run started in',
				collect,
				[]
			)
	).action(async (opts: CommonOpts & { default: number; state: string[] }) => {
		const api = client(opts);
		const overrides: Record<string, number> = {};
		for (const spec of opts.state) {
			const sep = spec.lastIndexOf('=');
			if (sep < 1 || sep === spec.length - 1) {
				die(`--state must look like <workflow>/<state>=<n>, got "${spec}"`);
			}
			const limit = Number.parseInt(spec.slice(sep + 1), 10);
			const { state } = await resolveStateFlag(api, spec.slice(0, sep));
			overrides[state.id] = limit;
		}
		const settings = await api.updateSupervisorSettings({
			quota: { type: 'state_roster', default_limit: opts.default, overrides }
		});
		if (opts.json) return printJson(settings);
		const workflows = await api.listWorkflows();
		const stateNames = new Map<string, string>();
		for (const wf of workflows.items) {
			for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
		}
		console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
	});
}
