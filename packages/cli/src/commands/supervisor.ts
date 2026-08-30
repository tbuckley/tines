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
import { quotaLabel, runnerStatusLabel } from '../format.js';
import { utilizationLabel } from '@tines/shared';
import type { Command } from 'commander';

export function register(program: Command): void {
	const supervisor = program
		.command('supervisor')
		.description('The automation kill switch, quota policy, and attempt limit');


	withCommon(supervisor.command('status').description('One-screen overview: kill switch, quota, utilization, runners')).action(
		async (opts: CommonOpts) => {
			const api = client(opts);
			const [settings, runnersRes, workflows, activeRuns] = await Promise.all([
				api.getSupervisorSettings(),
				api.listRunners(),
				api.listWorkflows({ limit: 100 }),
				api.listRuns({ active: true, limit: 100 })
			]);
			if (opts.json) {
				return printJson({ settings, runners: runnersRes.items, active_runs: activeRuns.items });
			}
			const stateNames = new Map<string, string>();
			for (const wf of workflows.items) {
				for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
			}
			console.log(`automation: ${settings.enabled ? 'ON' : 'OFF (kill switch — nothing dispatches)'}`);
			console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
			console.log(`utilization: ${utilizationLabel(settings.quota, activeRuns.items, (id) => stateNames.get(id) ?? id)}`);
			console.log(`attempt limit: ${settings.attempt_limit} strikes, then the issue parks`);
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
		}
	);

	withCommon(supervisor.command('enable').description('Arm automation (the kill switch on)')).action(
		async (opts: CommonOpts) => {
			const settings = await client(opts).updateSupervisorSettings({ enabled: true });
			if (opts.json) return printJson(settings);
			console.log('automation is ON — eligible issues with a matching rule will dispatch');
		}
	);

	withCommon(supervisor.command('disable').description('Pause all automation at once (the kill switch off)')).action(
		async (opts: CommonOpts) => {
			const settings = await client(opts).updateSupervisorSettings({ enabled: false });
			if (opts.json) return printJson(settings);
			console.log('automation is OFF — nothing new dispatches until re-enabled');
		}
	);

	const quota = supervisor.command('quota').description('Pick and configure the quota policy');

	withCommon(
		quota.command('global <n>').description('Use the global cap: at most <n> concurrent runs in total')
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
			.requiredOption('--default <n>', 'limit for states without an override', (v) => Number.parseInt(v, 10))
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
		const workflows = await api.listWorkflows({ limit: 100 });
		const stateNames = new Map<string, string>();
		for (const wf of workflows.items) {
			for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
		}
		console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
	});
}
