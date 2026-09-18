/** `tines routing` — scoped routing rules: which runner takes which issues. */
import {
	client,
	die,
	printJson,
	resolveLabelFlag,
	resolveProject,
	resolveRunner,
	resolveStateFlag,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import { ruleTargetsLabel } from '../format.js';
import { parseTargetSpec } from '../refs.js';
import { INHERIT_RUNNER_ID, type ApiClient } from '@tines/shared';
import type { Command } from 'commander';

interface RoutingScopeOpts {
	project?: string;
	state?: string;
	label?: string;
}

interface RoutingSetOpts extends RoutingScopeOpts {
	effort?: string[];
}

export function applyTargetEfforts<T extends { effort?: string }>(
	targets: T[],
	specs: string[]
): T[] {
	const seen = new Set<number>();
	for (const spec of specs) {
		const match = /^(\d+)=(.+)$/.exec(spec);
		if (!match) die(`invalid --effort ${JSON.stringify(spec)}; expected <target-number=value>`);
		const index = Number(match[1]);
		const value = match[2]!;
		if (!Number.isSafeInteger(index) || index < 1 || index > targets.length)
			die(`--effort target ${index} is out of range (1-${targets.length})`);
		if (seen.has(index)) die(`--effort target ${index} is specified more than once`);
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value))
			die(`invalid effort ${JSON.stringify(value)}; use a lowercase token of 1-32 characters`);
		seen.add(index);
		targets[index - 1] = { ...targets[index - 1]!, effort: value };
	}
	return targets;
}

/**
 * Resolves --project/--state/--label to rule scope ids (absent = global
 * dimension). A label outranks both of the others: `label security` beats
 * `project X · state Open`.
 */
async function resolveRoutingScope(
	api: ApiClient,
	opts: RoutingScopeOpts
): Promise<{
	projectId: string | null;
	stateId: string | null;
	labelId: string | null;
	label: string;
}> {
	const projectId =
		opts.project !== undefined ? (await resolveProject(api, opts.project)).id : null;
	const stateId =
		opts.state !== undefined ? (await resolveStateFlag(api, opts.state)).state.id : null;
	const labelId = opts.label !== undefined ? await resolveLabelFlag(api, opts.label) : null;
	const parts: string[] = [];
	if (opts.project) parts.push(`project ${opts.project}`);
	if (opts.state) parts.push(`state ${opts.state}`);
	if (opts.label) parts.push(`label ${opts.label}`);
	return { projectId, stateId, labelId, label: parts.length > 0 ? parts.join(' · ') : 'global' };
}

export function register(program: Command): void {
	const routing = program
		.command('routing')
		.description(
			'Scoped routing rules: which runner takes which issues (most specific scope wins)'
		);

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
			.description(
				"Create or replace a rule with <runner>[:tier] targets, or scoped '*:smartest' tier inheritance"
			)
			.option('-p, --project <name>', 'scope: project name or id')
			.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
			.option('-l, --label <name>', 'scope: issue label name or id')
			.option(
				'--effort <target-number=value>',
				'set routed effort for a 1-based target (repeatable)',
				(value, values: string[]) => [...values, value],
				[]
			)
	).action(async (targetSpecs: string[], opts: CommonOpts & RoutingSetOpts) => {
		const parsed: Array<ReturnType<typeof parseTargetSpec> & { effort?: string }> =
			targetSpecs.map(parseTargetSpec);
		const wildcard = parsed.filter((target) => target.name === INHERIT_RUNNER_ID);
		if (wildcard.length > 0) {
			if (parsed.length !== 1) die("'*:tier' cannot be mixed with runner targets");
			if (!wildcard[0]!.tier)
				die("the '*' target requires an explicit tier, for example '*:smartest'");
			if (opts.project === undefined && opts.state === undefined && opts.label === undefined) {
				die('a tier-only rule requires --project, --state, or --label');
			}
		}
		applyTargetEfforts(parsed, opts.effort ?? []);
		const api = client(opts);
		const scope = await resolveRoutingScope(api, opts);
		const targets: Array<{
			runner_id: string;
			tier?: 'smartest' | 'balanced' | 'cheapest';
			effort?: string;
		}> = [];
		for (const { name, tier, effort } of parsed) {
			if (name === INHERIT_RUNNER_ID) {
				targets.push({ runner_id: INHERIT_RUNNER_ID, tier: tier!, ...(effort ? { effort } : {}) });
			} else {
				const runner = await resolveRunner(api, name);
				targets.push({
					runner_id: runner.id,
					...(tier ? { tier } : {}),
					...(effort ? { effort } : {})
				});
			}
		}
		// One rule per exact scope: replace the existing rule's targets, else create.
		const { items } = await api.listRoutingRules();
		const existing = items.find(
			(r) =>
				r.scope.project_id === scope.projectId &&
				r.scope.workflow_state_id === scope.stateId &&
				r.scope.label_id === scope.labelId
		);
		const rule = existing
			? await api.updateRoutingRule(existing.id, { targets })
			: await api.createRoutingRule({
					project_id: scope.projectId,
					workflow_state_id: scope.stateId,
					label_id: scope.labelId,
					targets
				});
		if (opts.json) return printJson(rule);
		console.log(
			`${existing ? 'updated' : 'created'} the ${rule.scope.label} rule: ${ruleTargetsLabel(rule)}`
		);
		for (const warning of rule.warnings) console.log(`warning: ${warning.message}`);
	});

	withCommon(
		routing
			.command('clear')
			.description('Delete the rule at a scope (matching issues are re-evaluated)')
			.option('-p, --project <name>', 'scope: project name or id')
			.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
			.option('-l, --label <name>', 'scope: issue label name or id')
	).action(async (opts: CommonOpts & RoutingScopeOpts) => {
		const api = client(opts);
		const scope = await resolveRoutingScope(api, opts);
		const { items } = await api.listRoutingRules();
		const existing = items.find(
			(r) =>
				r.scope.project_id === scope.projectId &&
				r.scope.workflow_state_id === scope.stateId &&
				r.scope.label_id === scope.labelId
		);
		if (!existing) die(`no routing rule at scope ${scope.label}`);
		await api.deleteRoutingRule(existing.id);
		console.log(`cleared the ${existing.scope.label} rule`);
	});
}
