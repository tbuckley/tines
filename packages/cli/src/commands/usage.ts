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
	type CohortUsageReport,
	type CohortEntry,
	type IssueUsageReport,
	type IssueAttemptUsage,
	type UsageEvidencePage,
	type UsageBy,
	type UsageReport,
	type UsageWindow
} from '@tines/shared';
import { Option, type Command } from 'commander';
import { usageAggregateLines, usageEvidenceLines } from '../usage-format.js';

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
	cohort?: boolean;
	doneState?: string[];
	scope?: string;
	evidence?: 'issues' | 'runs' | 'entries';
	member?: string;
	population?: 'all' | 'finalized' | 'pending';
	sort?: 'cost' | 'time';
	direction?: 'asc' | 'desc';
	cursor?: string;
	limit?: string;
	allPages?: boolean;
	by: UsageBy;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

function printEvidence(page: UsageEvidencePage): void {
	console.log(
		`Usage evidence · ${page.kind} · ${page.population} · ${page.total_count} total · ${page.sort} ${page.direction}`
	);
	if (page.kind === 'issues')
		table([
			['ISSUE', 'SPEND', 'COVERAGE', 'RUNS'],
			...(page.items as IssueAttemptUsage[]).map((item) => [
				item.issue_ref
					? `${item.issue_ref.project_name}/${item.issue_ref.number} ${item.issue_ref.title}`
					: item.issue_id
						? `Unavailable issue (${item.issue_id})`
						: 'Unknown issue',
				money(item.aggregate.cost_usd),
				item.aggregate.coverage,
				String(item.attempt_count)
			])
		]);
	else if (page.kind === 'entries')
		table([
			['EVENT', 'ISSUE', 'STATE', 'AT', 'EVIDENCE'],
			...(page.items as CohortEntry[]).map((item) => [
				item.event_id,
				item.issue_id ?? 'Unavailable issue',
				item.state_name ?? item.state_id ?? 'Unclassifiable',
				new Date(item.created_at).toISOString(),
				item.chosen
					? 'Chosen completion'
					: item.reopening_relevant
						? 'Reopening witness'
						: item.qualifies
							? 'Qualifying entry'
							: (item.unavailable_reason ?? 'Excluded')
			])
		]);
	else
		table([
			['RUN', 'ISSUE', 'SPEND', 'AT'],
			...page.items.map((item) => {
				const run = item as typeof item & {
					id: string;
					issue_id: string;
					ended_at?: number | null;
					created_at: number;
					usage_accounting?: { cost: number | null };
				};
				return [
					run.id,
					run.issue_id,
					page.population === 'pending' ? 'Pending' : money(run.usage_accounting?.cost ?? null),
					new Date(run.ended_at ?? run.created_at).toISOString()
				];
			})
		]);
	if (page.kind === 'runs' && page.population === 'finalized')
		for (const item of page.items) {
			if ('id' in item && 'usage_accounting' in item && item.usage_dimensions)
				for (const line of usageEvidenceLines(
					item.id,
					item.usage_dimensions,
					item.usage_accounting
				))
					console.log(line);
		}
	console.log(
		`Matching total: ${money(page.matching_total.cost_usd)} · ${page.attempt_count} attempts · ${page.pending_count} pending`
	);
	if (page.next_cursor) console.log(`Next cursor: ${page.next_cursor}`);
}

function printIssueReport(report: IssueUsageReport): void {
	const { issue } = report;
	console.log(
		`Usage · ${issue.issue_ref ? `${issue.issue_ref.project_name}/${issue.issue_ref.number}` : issue.issue_id} · Lifetime through now`
	);
	console.log(`as of ${new Date(report.cutoff).toISOString()} · direct retained attempts`);
	if (issue.attempt_count === 0) console.log('No agent runs');
	else {
		console.log(
			`${money(issue.aggregate.cost_usd)} · ${issue.aggregate.coverage} · ${issue.aggregate.finalized_run_count} finalized · ${issue.pending_count} pending at cutoff`
		);
		for (const line of usageAggregateLines('Lifetime', issue.aggregate)) console.log(line);
	}
}

function printCohortReport(report: CohortUsageReport): void {
	console.log(`Completed issues · ${report.workflow.name}`);
	console.log(
		`${new Date(report.from).toISOString()} — ${new Date(report.to).toISOString()} · costs through exclusive cutoff`
	);
	console.log(
		`Terminal states: ${report.selected_states.map((state) => state.name).join(', ') || 'None available'}`
	);
	console.log('Completed-issue costs are not additive to period spend.');
	console.log(
		`${report.counters.distinct_issue_count} issues · ${report.counters.attempt_count}/${report.counters.distinct_issue_count} attempts/all issues · ${money(report.counters.known_cost_per_issue.value_usd)} known USD/all issues`
	);
	console.log(
		`${report.counters.priced_run_coverage.numerator}/${report.counters.priced_run_coverage.denominator} priced finalized runs · ${report.counters.fully_priced_issue_count}/${report.counters.distinct_issue_count} fully priced issues · ${report.counters.pending_count} pending · ${report.counters.zero_run_issue_count} no-run`
	);
	console.log(
		`${report.counters.reopened_issue_count} reopened · ${report.counters.reopening_history_unavailable_issue_count} reopening unknown · observed through ${new Date(report.observed_through).toISOString()}`
	);
	console.log(
		`History: ${report.history.status} · ${report.history.qualifying_fact_count} qualifying entries`
	);
	for (const state of report.terminal_states)
		console.log(
			`${state.state.name}: ${state.counters.distinct_issue_count} completed · ${money(state.aggregate.cost_usd)} known`
		);
	if (report.counters.distinct_issue_count === 0)
		console.log('No completed issues in available history');
	if (report.scope) console.log(`Scope: ${report.scope}`);
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
			.option('--cohort', 'report issues completed in the selected workflow and window')
			.option(
				'--done-state <id>',
				'terminal state id (repeatable; defaults to all done states)',
				collect
			)
			.option('--scope <token>', 'replay a frozen usage scope')
			.addOption(
				new Option('--evidence <kind>', 'list evidence').choices(['issues', 'runs', 'entries'])
			)
			.option('--member <issue-id>', 'narrow run evidence to one contributing issue')
			.addOption(
				new Option('--population <population>', 'all, finalized, or pending').choices([
					'all',
					'finalized',
					'pending'
				])
			)
			.addOption(new Option('--sort <sort>', 'evidence sort').choices(['cost', 'time']))
			.addOption(new Option('--direction <direction>', 'sort direction').choices(['asc', 'desc']))
			.option('--cursor <token>', 'evidence page cursor')
			.option('--limit <count>', 'evidence page size (1-100)')
			.option('--all-pages', 'fetch every evidence page')
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
	).action(async (opts: UsageOpts, command: Command) => {
		const evidenceOnly = [
			opts.member,
			opts.population,
			opts.sort,
			opts.direction,
			opts.cursor,
			opts.limit,
			opts.allPages
		];
		if (evidenceOnly.some((value) => value !== undefined) && !opts.evidence)
			throw new Error(
				'--member/--population/--sort/--direction/--cursor/--limit/--all-pages require --evidence'
			);
		if (opts.evidence && !opts.scope) throw new Error('--evidence requires --scope');
		if (opts.scope) {
			const reportFlags = [
				opts.issue,
				opts.cohort,
				opts.doneState,
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
			if (command.getOptionValueSource('by') === 'cli') reportFlags.push(opts.by);
			if (reportFlags.some((value) => value !== undefined))
				throw new Error('--scope cannot be combined with report options');
			const api = client(opts);
			if (!opts.evidence) {
				const report = await api.getUsageScope(opts.scope);
				if (opts.json) return printJson(report);
				if (report.mode === 'issue') printIssueReport(report);
				else if (report.mode === 'cohort') printCohortReport(report);
				else printReport(report);
				return;
			}
			let cursor = opts.cursor;
			const seenCursors = new Set<string>();
			const seenIds = new Set<string>();
			let combined: UsageEvidencePage | null = null;
			do {
				if (cursor && seenCursors.has(cursor))
					throw new Error('Evidence pagination repeated a cursor');
				if (cursor) seenCursors.add(cursor);
				const page = await api.getUsageEvidence({
					scope: opts.scope,
					kind: opts.evidence,
					population: opts.population,
					member: opts.member,
					sort: opts.sort,
					direction: opts.direction,
					limit: opts.limit ? Number(opts.limit) : undefined,
					cursor
				});
				for (const item of page.items) {
					const id =
						'event_id' in item
							? item.event_id
							: 'id' in item
								? item.id
								: ((item as IssueAttemptUsage).issue_id ?? 'unknown');
					if (seenIds.has(id)) throw new Error(`Evidence pagination repeated ${id}`);
					seenIds.add(id);
				}
				combined = combined
					? { ...page, items: [...combined.items, ...page.items], previous_cursor: null }
					: page;
				cursor = page.next_cursor ?? undefined;
			} while (opts.allPages && cursor);
			if (!combined) throw new Error('Evidence response was empty');
			if (opts.json) return printJson(combined);
			printEvidence(combined);
			return;
		}
		if (opts.issue) {
			const contradictions = [
				opts.cohort,
				opts.doneState,
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
			if (command.getOptionValueSource('by') === 'cli') contradictions.push(opts.by);
			if (contradictions.some((value) => value !== undefined))
				throw new Error('--issue cannot be combined with period or filter options');
			const api = client(opts);
			const issueId = isUsageIdentity(opts.issue, 'iss')
				? opts.issue
				: (await resolveIssue(api, opts.issue)).id;
			const report = await api.getIssueUsage(issueId);
			if (opts.json) return printJson(report);
			printIssueReport(report);
			return;
		}
		if (opts.doneState?.length && !opts.cohort) throw new Error('--done-state requires --cohort');
		if (opts.cohort) {
			if (!opts.workflow) throw new Error('--cohort requires --workflow');
			if (
				[
					opts.issue,
					opts.scope,
					opts.state,
					opts.runner,
					opts.tier,
					opts.outcome,
					opts.accountingStatus
				].some((value) => value !== undefined) ||
				command.getOptionValueSource('by') === 'cli'
			)
				throw new Error('--cohort cannot be combined with issue, scope, grouping, or run filters');
			if ((opts.from === undefined) !== (opts.to === undefined))
				throw new Error('--from and --to are required together');
			if (opts.window && opts.from) throw new Error('--window cannot be combined with --from/--to');
			const api = client(opts);
			const project =
				opts.project && !isUsageIdentity(opts.project, 'prj')
					? (await resolveProject(api, opts.project)).id
					: opts.project;
			const workflow = !isUsageIdentity(opts.workflow, 'wf')
				? (await resolveWorkflow(api, opts.workflow)).id
				: opts.workflow;
			const report = await api.getCohortUsage({
				workflow,
				project,
				window: opts.window,
				from: opts.from,
				to: opts.to,
				done_state: opts.doneState
			});
			if (opts.json) return printJson(report);
			printCohortReport(report);
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
