import {
	client,
	isUsageIdentity,
	printJson,
	resolveProject,
	resolveRunner,
	resolveIssue,
	resolveWorkflow,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import {
	usageCostLabel,
	type IssueUsageReport,
	type UsageBy,
	type UsageReport,
	type UsageWindow
} from '@tines/shared';
import { Option, type Command } from 'commander';
import { usageAggregateLines } from '../usage-format.js';

interface UsageOpts extends CommonOpts {
	window?: UsageWindow;
	from?: string;
	to?: string;
	project?: string;
	workflow?: string;
	state?: string;
	runner?: string;
	tier?: string;
	outcome?: string;
	accountingStatus?: string;
	issue?: string;
	by: UsageBy;
}

function printIssueReport(report: IssueUsageReport): void {
	const { issue } = report;
	console.log(`Usage · ${issue.issue_ref ?? issue.issue_id} · Lifetime through now`);
	console.log(`as of ${new Date(report.cutoff).toISOString()} · direct retained attempts`);
	if (issue.attempt_count === 0) console.log('No agent runs');
	else {
		console.log(
			`${money(issue.aggregate.cost_usd)} · ${issue.aggregate.coverage} · ${issue.aggregate.finalized_run_count} finalized · ${issue.pending_count} pending at cutoff`
		);
		for (const line of usageAggregateLines('Lifetime', issue.aggregate)) console.log(line);
	}
}

const money = (value: number | null) => usageCostLabel(value);

function printReport(report: UsageReport): void {
	console.log(`Usage · ${report.filters.project ?? 'All projects'} · ${report.by}`);
	console.log(
		`${new Date(report.from).toISOString()} — ${new Date(report.to).toISOString()} · ${report.timezone} (${report.timezone_source.replace('_', ' ')})`
	);
	console.log(
		`generated ${new Date(report.generated_at).toISOString()} · ${report.accounting_basis}`
	);
	const scope = report.scope_total;
	console.log(
		`Scope total: ${money(scope.cost_usd)} · ${scope.coverage} · ${scope.finalized_run_count} finalized · ${scope.priced_run_count} priced · ${scope.unpriced_run_count + scope.unreported_run_count} without price`
	);
	if (
		JSON.stringify(report.filters) !==
		JSON.stringify({ ...(report.filters.project ? { project: report.filters.project } : {}) })
	) {
		const matching = report.matching_total;
		console.log(
			`Matching subtotal: ${money(matching.cost_usd)} · ${matching.coverage} · ${matching.finalized_run_count} finalized`
		);
	}
	const total = report.matching_total;
	console.log(
		`Pending at cutoff: ${report.pending.matching_count}${report.pending.unapplied_filters.length ? ` (before ${report.pending.unapplied_filters.join('/')} filters)` : ''}`
	);
	if (report.groups.length === 0) console.log('no finalized runs');
	else
		table([
			['GROUP', 'SPEND', 'COVERAGE', 'FINAL', 'PRICED', 'MISSING', 'MEDIAN', 'P95', 'MAX', 'MEAN'],
			...report.groups.map(({ dimension, aggregate: a }) => [
				dimension.name,
				money(a.cost_usd),
				a.coverage,
				String(a.finalized_run_count),
				String(a.priced_run_count),
				String(a.unpriced_run_count + a.unreported_run_count),
				money(a.distribution.median_cost_usd),
				money(a.distribution.p95_cost_usd),
				money(a.distribution.max_cost_usd),
				money(a.distribution.mean_cost_usd)
			])
		]);
	console.log('Per-run cost · priced subset; p95 uses nearest rank.');
	if (report.groups.some((g) => g.aggregate.distribution.low_sample))
		console.log('Small samples (under 20): p95 equals maximum.');
	console.log(
		`Matching tokens: ${Object.entries(total.tokens)
			.map(
				([name, t]) =>
					`${name} ${t.value ?? 'unknown'} (${t.reported_runs}/${total.finalized_run_count} runs)`
			)
			.join(' · ')}`
	);
	console.log(
		`Matching sources: provider ${total.portions.provider.cost_usd_exact} · calculated ${total.portions.calculated.cost_usd_exact} · unknown ${total.portions.unknown_source.cost_usd_exact}`
	);
	for (const line of usageAggregateLines('Scope', scope)) console.log(line);
	for (const line of usageAggregateLines('Matching', total)) console.log(line);
}

export function register(program: Command): void {
	withCommon(
		program
			.command('usage')
			.description('Compare finalized run spend for a period')
			.addOption(
				new Option('--window <window>', 'today, 7d, or 30d').choices(['today', '7d', '30d'])
			)
			.option('--from <bound>', 'custom inclusive start (date or offset timestamp)')
			.option('--to <bound>', 'custom exclusive end (date or offset timestamp)')
			.option('--issue <ref>', 'direct issue lifetime through now')
			.option('--project <name-or-id>', 'project scope (including archived), or unknown')
			.option('--workflow <name-or-id>', 'workflow filter, or unknown')
			.option('--state <id>', 'starting state id (requires --workflow)')
			.option('--runner <name-or-id>', 'runner filter, or unknown')
			.option('--tier <tier>', 'tier filter')
			.addOption(
				new Option('--outcome <outcome>', 'recorded outcome').choices([
					'advanced',
					'stalled',
					'interrupted',
					'unknown'
				])
			)
			.addOption(
				new Option('--accounting-status <status>', 'price coverage').choices([
					'priced',
					'unpriced',
					'unreported'
				])
			)
			.addOption(
				new Option('--by <dimension>', 'group dimension')
					.choices(['project', 'workflow', 'state', 'outcome', 'runner', 'tier'])
					.default('workflow')
			)
	).action(async (opts: UsageOpts) => {
		if (opts.issue) {
			const contradictions = [
				opts.window,
				opts.from,
				opts.to,
				opts.project,
				opts.workflow,
				opts.state,
				opts.runner,
				opts.tier,
				opts.outcome,
				opts.accountingStatus
			];
			if (contradictions.some((value) => value !== undefined))
				throw new Error('--issue cannot be combined with period or filter options');
			const api = client(opts);
			const issue = await resolveIssue(api, opts.issue);
			const report = await api.getIssueUsage(issue.id);
			if (opts.json) return printJson(report);
			printIssueReport(report);
			return;
		}
		if ((opts.from === undefined) !== (opts.to === undefined))
			throw new Error('--from and --to are required together');
		if (opts.window && opts.from) throw new Error('--window cannot be combined with --from/--to');
		if (opts.state && !opts.workflow) throw new Error('--state requires --workflow');
		const api = client(opts);
		const project =
			opts.project && !isUsageIdentity(opts.project, 'prj')
				? (await resolveProject(api, opts.project)).id
				: opts.project;
		const workflow =
			opts.workflow && !isUsageIdentity(opts.workflow, 'wf')
				? (await resolveWorkflow(api, opts.workflow)).id
				: opts.workflow;
		const runner =
			opts.runner && !isUsageIdentity(opts.runner, 'rnr')
				? (await resolveRunner(api, opts.runner)).id
				: opts.runner;
		const report = await api.getUsage({
			window: opts.window,
			from: opts.from,
			to: opts.to,
			project,
			workflow,
			state: opts.state,
			runner,
			tier: opts.tier,
			outcome: opts.outcome as never,
			accounting_status: opts.accountingStatus as never,
			by: opts.by
		});
		if (opts.json) return printJson(report);
		printReport(report);
	});
}
