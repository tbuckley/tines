/** `tines routing` — scoped routing rules: which runner takes which issues. */
import {
	client,
	die,
	printJson,
	resolveProject,
	resolveRunner,
	resolveStateFlag,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import { ruleTargetsLabel } from '../format.js';
import { parseTargetSpec } from '../refs.js';
import { type ApiClient } from '@tines/shared';
import type { Command } from 'commander';

interface RoutingScopeOpts {
	project?: string;
	state?: string;
}

/** Resolves --project/--state to rule scope ids (absent = global dimension). */
async function resolveRoutingScope(
	api: ApiClient,
	opts: RoutingScopeOpts
): Promise<{ projectId: string | null; stateId: string | null; label: string }> {
	const projectId = opts.project !== undefined ? (await resolveProject(api, opts.project)).id : null;
	const stateId = opts.state !== undefined ? (await resolveStateFlag(api, opts.state)).state.id : null;
	const parts: string[] = [];
	if (opts.project) parts.push(`project ${opts.project}`);
	if (opts.state) parts.push(`state ${opts.state}`);
	return { projectId, stateId, label: parts.length > 0 ? parts.join(' · ') : 'global' };
}

export function register(program: Command): void {
	const routing = program
		.command('routing')
		.description('Scoped routing rules: which runner takes which issues (most specific scope wins)');

	withCommon(routing.command('list').description('List routing rules, most specific first')).action(
		async (opts: CommonOpts) => {
			const res = await client(opts).listRoutingRules();
			if (opts.json) return printJson(res);
			if (res.items.length === 0) return console.log('no routing rules — nothing will dispatch');
			table([
				['SCOPE', 'TARGETS', 'ID'],
				...res.items.map((r) => [r.scope.label, ruleTargetsLabel(r), r.id])
			]);
		}
	);

	withCommon(
		routing
			.command('set <target...>')
			.description('Create or replace the rule at a scope: an ordered list of <runner>[:tier] targets')
			.option('-p, --project <name>', 'scope: project name or id')
			.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
	).action(async (targetSpecs: string[], opts: CommonOpts & RoutingScopeOpts) => {
		const api = client(opts);
		const scope = await resolveRoutingScope(api, opts);
		const targets = [];
		for (const spec of targetSpecs) {
			const { name, tier } = parseTargetSpec(spec);
			const runner = await resolveRunner(api, name);
			targets.push(tier ? { runner_id: runner.id, tier } : { runner_id: runner.id });
		}
		// One rule per exact scope: replace the existing rule's targets, else create.
		const { items } = await api.listRoutingRules();
		const existing = items.find(
			(r) => r.scope.project_id === scope.projectId && r.scope.workflow_state_id === scope.stateId
		);
		const rule = existing
			? await api.updateRoutingRule(existing.id, { targets })
			: await api.createRoutingRule({ project_id: scope.projectId, workflow_state_id: scope.stateId, targets });
		if (opts.json) return printJson(rule);
		console.log(
			`${existing ? 'updated' : 'created'} the ${rule.scope.label} rule: ${ruleTargetsLabel(rule)}`
		);
		for (const warning of rule.warnings) console.log(`warning: ${warning.message}`);
	});

	withCommon(
		routing
			.command('clear')
			.description('Delete the rule at a scope (issues it matched stop dispatching)')
			.option('-p, --project <name>', 'scope: project name or id')
			.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
	).action(async (opts: CommonOpts & RoutingScopeOpts) => {
		const api = client(opts);
		const scope = await resolveRoutingScope(api, opts);
		const { items } = await api.listRoutingRules();
		const existing = items.find(
			(r) => r.scope.project_id === scope.projectId && r.scope.workflow_state_id === scope.stateId
		);
		if (!existing) die(`no routing rule at scope ${scope.label}`);
		await api.deleteRoutingRule(existing.id);
		console.log(`cleared the ${existing.scope.label} rule`);
	});
}
