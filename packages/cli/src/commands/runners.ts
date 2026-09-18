/** `tines runners` / `runner` / `runs` — the runner registry, the local daemon, and agent runs. */
import {
	client,
	die,
	fetchList,
	isUsageIdentity,
	printJson,
	printList,
	resolveApiKey,
	resolveIssue,
	resolveProject,
	resolveRunner,
	resolveWorkflow,
	resolveUrl,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { runDaemon } from '../daemon/daemon.js';
import {
	defaultConfigDir,
	directorySizeBytes,
	hasRunnerCredentials,
	listKeptWorkspaces,
	pruneKeptWorkspaces,
	saveRunnerCredentials,
	workspacesDir
} from '../daemon/store.js';
import { parseDaemonFlags, withDaemonFlags, type DaemonFlagValues } from './daemon-flags.js';
import { registerServiceCommands } from './runner-service.js';
import {
	issueRef,
	keptWorkspaceRow,
	runRow,
	runnerConcurrencyLabel,
	runnerStatusLabel,
	timestamp
} from '../format.js';
import {
	DEFAULT_RESUME_MAX_COST_USD,
	DEFAULT_RESUME_MAX_TOKENS,
	DEFAULT_RESUME_MAX_TURNS,
	DEFAULT_RESUME_WINDOW_HOURS,
	isStaleTierOverride,
	MODEL_TIERS,
	runCostLabel,
	runDurationLabel,
	type ModelTier,
	type Runner,
	type UsagePendingRun,
	type UpdateRunnerRequest
} from '@tines/shared';
import { InvalidArgumentError, Option, type Command } from 'commander';
import { usageEvidenceLines } from '../usage-format.js';

function parseBoolean(value: string): boolean {
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new InvalidArgumentError('must be true or false');
}

function boundedInteger(min: number, max: number) {
	return (value: string): number => {
		if (!/^\d+$/.test(value))
			throw new InvalidArgumentError(`must be an integer between ${min} and ${max}`);
		const parsed = Number(value);
		if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
			throw new InvalidArgumentError(`must be an integer between ${min} and ${max}`);
		}
		return parsed;
	};
}

function resumeCost(value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
		throw new InvalidArgumentError('must be greater than 0 and at most 1000');
	}
	return parsed;
}

/** The tier mapping, shared by `runners show` and `runners tiers`. */
function printTierTable(runner: Runner): void {
	if (!runner.tier_models && !runner.tiers) {
		console.log("tiers: don't apply to this runner (fixed configuration)");
		return;
	}
	console.log('tiers:');
	for (const tier of MODEL_TIERS) {
		const override = runner.tiers?.[tier];
		const builtin = runner.tier_models?.[tier] ?? null;
		const model = override?.model ?? builtin ?? '(unknown)';
		const source = override ? 'override' : 'built-in';
		const stale = isStaleTierOverride(builtin, override?.model);
		const marks = [
			tier === runner.default_tier ? 'default' : null,
			override?.effort ? `effort ${override.effort}` : null,
			stale ? `stale — built-in is now ${builtin}` : null
		].filter(Boolean);
		console.log(
			`  ${tier}: ${model}  [${source}]${marks.length > 0 ? `  (${marks.join(', ')})` : ''}`
		);
	}
}

export function register(program: Command): void {
	const runners = program.command('runners').description('Manage the runner registry');

	withCommon(runners.command('list').description('List runners')).action(
		async (opts: CommonOpts) => {
			const res = await client(opts).listRunners();
			if (opts.json) return printJson(res);
			if (res.items.length === 0) return console.log('no runners');
			table([
				['NAME', 'TYPE', 'STATUS', 'RUNS', 'CONCURRENCY', 'TIER', 'LAST SEEN'],
				...res.items.map((r) => [
					r.name,
					r.type,
					runnerStatusLabel(r),
					`${r.active_runs}/${r.max_concurrent}`,
					runnerConcurrencyLabel(r),
					r.default_tier,
					r.last_seen_at ? timestamp(r.last_seen_at) : '—'
				])
			]);
		}
	);

	withCommon(runners.command('show <name>').description('Show a runner')).action(
		async (ref: string, opts: CommonOpts) => {
			const runner = await resolveRunner(client(opts), ref);
			if (opts.json) return printJson(runner);
			console.log(`${runner.name}  (${runner.type})  [${runner.id}]  ${runnerStatusLabel(runner)}`);
			console.log(
				`active runs: ${runner.active_runs}/${runner.max_concurrent}  timeout: ${runner.max_run_minutes}m  default tier: ${runner.default_tier}`
			);
			console.log(`concurrency: ${runnerConcurrencyLabel(runner)}`);
			if (runner.last_seen_at) console.log(`last seen: ${timestamp(runner.last_seen_at)}`);
			if (runner.backoff_reason === 'rate_limit' && runner.backoff_until) {
				console.log(
					`rate limited: the harness account is out of usage; resumes ${timestamp(runner.backoff_until)}`
				);
			}
			if (runner.launch_failures > 0) {
				console.log(
					`consecutive failures: ${runner.launch_failures}${runner.backoff_until ? ` (backing off until ${timestamp(runner.backoff_until)})` : ''}`
				);
			}
			const harness = runner.config.harness;
			if (typeof harness === 'string') console.log(`harness: ${harness}`);
			if (runner.type !== 'local') {
				console.log(`api key: ${runner.has_api_key ? 'set (write-only)' : 'missing'}`);
			}
			console.log(
				`resume awaiting sessions: ${(runner.resume_enabled ?? false) ? 'enabled' : 'disabled'}  window: ${runner.resume_window_hours ?? DEFAULT_RESUME_WINDOW_HOURS}h (staged; runtime continuation unavailable)`
			);
			console.log(
				`resume limits: ${runner.resume_max_turns ?? DEFAULT_RESUME_MAX_TURNS} local turns  ${(runner.resume_max_tokens ?? DEFAULT_RESUME_MAX_TOKENS).toLocaleString()} managed tokens  $${runner.resume_max_cost_usd ?? DEFAULT_RESUME_MAX_COST_USD} managed cost`
			);
			if (runner.budget) {
				const b = runner.budget;
				const parts: string[] = [];
				if (b.max_run_cost_usd !== undefined) parts.push(`$${b.max_run_cost_usd}/run`);
				if (b.max_run_tokens !== undefined)
					parts.push(`${b.max_run_tokens.toLocaleString()} tok/run`);
				if (b.daily_usd !== undefined) parts.push(`$${b.daily_usd}/day`);
				if (b.daily_tokens !== undefined) parts.push(`${b.daily_tokens.toLocaleString()} tok/day`);
				if (parts.length > 0) console.log(`budget: ${parts.join('  ')}`);
			}
			printTierTable(runner);
		}
	);

	withCommon(
		runners
			.command('edit <name>')
			.description('Edit staged awaiting-session continuation policy (runtime unavailable)')
			.option(
				'--resume-enabled <true|false>',
				'stage opt-in policy (enabling is unavailable until provider support ships)',
				parseBoolean
			)
			.option('--resume-window-hours <n>', 'continuation window (1-168)', boundedInteger(1, 168))
			.option(
				'--resume-max-turns <n>',
				'local conversation turn limit (1-1000)',
				boundedInteger(1, 1000)
			)
			.option(
				'--resume-max-tokens <n>',
				'managed conversation token limit (1-10000000)',
				boundedInteger(1, 10_000_000)
			)
			.option('--resume-max-cost-usd <n>', 'managed conversation cost limit (0-1000]', resumeCost)
	).action(
		async (
			ref: string,
			opts: CommonOpts & {
				resumeEnabled?: boolean;
				resumeWindowHours?: number;
				resumeMaxTurns?: number;
				resumeMaxTokens?: number;
				resumeMaxCostUsd?: number;
			}
		) => {
			const patch: UpdateRunnerRequest = {
				...(opts.resumeEnabled !== undefined ? { resume_enabled: opts.resumeEnabled } : {}),
				...(opts.resumeWindowHours !== undefined
					? { resume_window_hours: opts.resumeWindowHours }
					: {}),
				...(opts.resumeMaxTurns !== undefined ? { resume_max_turns: opts.resumeMaxTurns } : {}),
				...(opts.resumeMaxTokens !== undefined ? { resume_max_tokens: opts.resumeMaxTokens } : {}),
				...(opts.resumeMaxCostUsd !== undefined
					? { resume_max_cost_usd: opts.resumeMaxCostUsd }
					: {})
			};
			if (Object.keys(patch).length === 0) die('provide at least one resume setting');
			const api = client(opts);
			const runner = await resolveRunner(api, ref);
			const updated = await api.updateRunner(runner.id, patch);
			if (opts.json) return printJson(updated);
			console.log(
				`updated runner "${updated.name}"; awaiting-session resume is ${updated.resume_enabled ? 'enabled' : 'disabled'}`
			);
		}
	);

	withCommon(
		runners
			.command('tiers <name>')
			.description("Show or edit a runner's tier→model mapping")
			.option('--default <tier>', 'set the default tier (used by targets without an explicit tier)')
			.option('--set <tier=model...>', 'override a tier with an exact model id (repeatable)')
			.option('--unset <tier...>', 'drop an override, falling back to the built-in (repeatable)')
	).action(
		async (
			ref: string,
			opts: CommonOpts & { default?: string; set?: string[]; unset?: string[] }
		) => {
			const api = client(opts);
			const runner = await resolveRunner(api, ref);
			const patch: UpdateRunnerRequest = {};
			if (opts.default !== undefined) {
				if (!(MODEL_TIERS as readonly string[]).includes(opts.default)) {
					die(`unknown tier "${opts.default}" (tiers: ${MODEL_TIERS.join(', ')})`);
				}
				patch.default_tier = opts.default as ModelTier;
			}
			if (opts.set?.length || opts.unset?.length) {
				const tiers: Record<string, { model: string; effort?: string } | undefined> = {
					...(runner.tiers ?? {})
				};
				for (const entry of opts.set ?? []) {
					const eq = entry.indexOf('=');
					if (eq === -1) die(`--set takes <tier>=<model-id>, got "${entry}"`);
					const tier = entry.slice(0, eq);
					const model = entry.slice(eq + 1);
					if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
						die(`unknown tier "${tier}" (tiers: ${MODEL_TIERS.join(', ')})`);
					}
					if (!model) die(`--set ${tier}= needs a model id`);
					tiers[tier] = { ...tiers[tier], model };
				}
				for (const tier of opts.unset ?? []) {
					if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
						die(`unknown tier "${tier}" (tiers: ${MODEL_TIERS.join(', ')})`);
					}
					delete tiers[tier];
				}
				patch.tiers =
					Object.keys(tiers).length > 0 ? (tiers as UpdateRunnerRequest['tiers']) : null;
			}
			const updated =
				Object.keys(patch).length > 0 ? await api.updateRunner(runner.id, patch) : runner;
			if (opts.json) return printJson(updated);
			console.log(`${updated.name}  (${updated.type})  default tier: ${updated.default_tier}`);
			printTierTable(updated);
			if (Object.keys(patch).length > 0) {
				console.log('changes apply at the next launch; running work is untouched.');
			}
		}
	);

	withCommon(
		runners
			.command('budget <name>')
			.description(
				"Set or clear a runner's money limits (per-run caps enforce now; daily limits arrive with the budgets milestone)"
			)
			.option('--max-run-usd <n>', 'hard per-run cost cap (platform-enforced on Claude runners)')
			.option('--max-run-tokens <n>', 'hard per-run token cap (input + output)')
			.option('--daily-usd <n>', 'daily USD limit (stored now, enforced by the budgets milestone)')
			.option(
				'--daily-tokens <n>',
				'daily token limit (stored now, enforced by the budgets milestone)'
			)
			.option('--clear', 'remove all limits')
	).action(
		async (
			ref: string,
			opts: CommonOpts & {
				maxRunUsd?: string;
				maxRunTokens?: string;
				dailyUsd?: string;
				dailyTokens?: string;
				clear?: boolean;
			}
		) => {
			const api = client(opts);
			const runner = await resolveRunner(api, ref);
			const flags = [opts.maxRunUsd, opts.maxRunTokens, opts.dailyUsd, opts.dailyTokens].some(
				(v) => v !== undefined
			);
			if (opts.clear && flags) die('--clear cannot be combined with limit flags');
			let updated = runner;
			if (opts.clear) {
				updated = await api.updateRunner(runner.id, { budget: null });
			} else if (flags) {
				const num = (value: string, flag: string): number => {
					const n = Number(value);
					if (!Number.isFinite(n) || n <= 0)
						die(`${flag} must be a positive number, got "${value}"`);
					return n;
				};
				updated = await api.updateRunner(runner.id, {
					budget: {
						...(runner.budget ?? {}),
						...(opts.maxRunUsd !== undefined
							? { max_run_cost_usd: num(opts.maxRunUsd, '--max-run-usd') }
							: {}),
						...(opts.maxRunTokens !== undefined
							? { max_run_tokens: num(opts.maxRunTokens, '--max-run-tokens') }
							: {}),
						...(opts.dailyUsd !== undefined
							? { daily_usd: num(opts.dailyUsd, '--daily-usd') }
							: {}),
						...(opts.dailyTokens !== undefined
							? { daily_tokens: num(opts.dailyTokens, '--daily-tokens') }
							: {})
					}
				});
			}
			if (opts.json) return printJson(updated);
			const b = updated.budget;
			if (!b) return console.log(`no limits on "${updated.name}"`);
			console.log(`limits on "${updated.name}":`);
			if (b.max_run_cost_usd !== undefined) console.log(`  $${b.max_run_cost_usd} per run`);
			if (b.max_run_tokens !== undefined)
				console.log(`  ${b.max_run_tokens.toLocaleString()} tokens per run`);
			if (b.daily_usd !== undefined)
				console.log(`  $${b.daily_usd} per day (enforced by the budgets milestone)`);
			if (b.daily_tokens !== undefined) {
				console.log(
					`  ${b.daily_tokens.toLocaleString()} tokens per day (enforced by the budgets milestone)`
				);
			}
		}
	);

	withCommon(
		runners
			.command('pause <name>')
			.description('Pause a runner (stops new assignments; identity and rules stay)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		const updated = await api.updateRunner(runner.id, { status: 'paused' });
		if (opts.json) return printJson(updated);
		console.log(`paused runner "${updated.name}"`);
	});

	withCommon(runners.command('resume <name>').description('Resume a paused runner')).action(
		async (ref: string, opts: CommonOpts) => {
			const api = client(opts);
			const runner = await resolveRunner(api, ref);
			const updated = await api.updateRunner(runner.id, { status: 'active' });
			if (opts.json) return printJson(updated);
			console.log(`resumed runner "${updated.name}"`);
		}
	);

	withCommon(
		runners
			.command('remove <name>')
			.description(
				'Remove a runner (refused while routing rules or pins reference it, unless --force)'
			)
			.option(
				'--force',
				'strip the runner from routing rules and clear issue pins (emptied rules are kept, flagged)'
			)
	).action(async (ref: string, opts: CommonOpts & { force?: boolean }) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		await api.deleteRunner(runner.id, opts.force ? { force: true } : undefined);
		console.log(`removed runner "${runner.name}"${opts.force ? ' (references stripped)' : ''}`);
	});

	withCommon(
		runners
			.command('rotate-token <name>')
			.description("Invalidate a local runner's token and mint a fresh one (shown once)")
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		const rotated = await api.rotateRunnerToken(runner.id);
		if (opts.json) return printJson(rotated);
		const url = resolveUrl(opts);
		console.log(`rotated the token for runner "${rotated.runner.name}" — the old token is dead.`);
		console.log(`new token (shown once): ${rotated.runner_token}`);
		if (hasRunnerCredentials(defaultConfigDir(), url, rotated.runner.name)) {
			// This machine runs the daemon: adopt the new token in place so a
			// restart just works.
			saveRunnerCredentials(defaultConfigDir(), url, rotated.runner.name, {
				runner_id: rotated.runner.id,
				token: rotated.runner_token
			});
			console.log(
				`stored it for the daemon on this machine (${defaultConfigDir()}); restart the daemon to adopt it.`
			);
		} else {
			console.log(
				"drop it into the daemon machine's config — its next poll gets a 401 until it adopts the new token."
			);
		}
	});

	// --- runner daemon -----------------------------------------------------------

	const runnerCmd = program.command('runner').description('The local runner daemon');

	withCommon(
		withDaemonFlags(
			runnerCmd
				.command('daemon')
				.description(
					'Run the local runner daemon in the foreground: register/reconnect, poll for assigned runs, execute them (`tines runner install` runs it as a service instead)'
				)
		)
			.option(
				'--no-cli-refresh',
				'do not install/refresh the agent-facing tines CLI from npm (harnesses use the ambient PATH)'
			)
			.option(
				'--no-self-update',
				'do not exit for the service manager to relaunch a newer daemon (only applies when launched from the daemon-managed prefix)'
			)
	).action(
		async (opts: CommonOpts & DaemonFlagValues & { cliRefresh: boolean; selfUpdate: boolean }) => {
			const settings = parseDaemonFlags(opts);
			await runDaemon({
				url: resolveUrl(opts).replace(/\/+$/, ''),
				apiKey: resolveApiKey(opts),
				name: settings.name,
				harness: settings.harness,
				command: settings.command,
				maxConcurrent: settings.maxConcurrent,
				allowRemoteConcurrency: settings.allowRemoteConcurrency,
				pollIntervalMs: settings.pollIntervalSeconds * 1000,
				configDir: defaultConfigDir(),
				cliRefresh: opts.cliRefresh,
				selfUpdate: opts.selfUpdate,
				keepWorkspaces: settings.keepWorkspaces,
				keepWorkspacesForHours: settings.keepWorkspacesForHours,
				keepWorkspacesMax: settings.keepWorkspacesMax
			});
		}
	);

	// --- runner as a service ------------------------------------------------------
	registerServiceCommands(runnerCmd);

	// --- kept workspaces ---------------------------------------------------------
	// Pure filesystem, no API: these read the same config dir the daemon writes,
	// and are useful precisely when the supervisor is not what you are debugging.

	const workspacesCmd = runnerCmd
		.command('workspaces')
		.description('List run workspaces the daemon kept for debugging (--keep-workspaces)')
		.option('--json', 'print JSON instead of a table')
		.action((opts: { json?: boolean }) => {
			const configDir = defaultConfigDir();
			const kept = listKeptWorkspaces(configDir);
			const sized = kept.map((k) => ({ ...k, size_bytes: directorySizeBytes(k.path) }));
			if (opts.json) return printJson({ items: sized });
			if (sized.length === 0) {
				console.log(`no kept workspaces in ${workspacesDir(configDir)}`);
				return console.log('the daemon keeps them only with --keep-workspaces failed (or always).');
			}
			table([
				['RUN', 'ISSUE', 'STATUS', 'AGE', 'SIZE', 'PATH'],
				...sized.map((k) => keptWorkspaceRow(k, k.size_bytes))
			]);
		});

	workspacesCmd
		.command('prune')
		.description("Delete kept workspaces (never touches a live run's workspace)")
		.option('--all', 'delete every kept workspace')
		.option('--older-than <hours>', 'delete kept workspaces older than this', (v) => Number(v))
		.option('--json', 'print JSON instead of a table')
		.action((opts: { all?: boolean; olderThan?: number; json?: boolean }) => {
			// No default window: this command cannot know what the daemon was
			// started with, and guessing would delete evidence.
			if (opts.all === undefined && opts.olderThan === undefined) {
				die('pass --all or --older-than <hours>');
			}
			if (opts.all && opts.olderThan !== undefined)
				die('--all cannot be combined with --older-than');
			if (
				opts.olderThan !== undefined &&
				(!Number.isFinite(opts.olderThan) || opts.olderThan < 0)
			) {
				die('--older-than must be a non-negative number of hours');
			}
			const removed = pruneKeptWorkspaces(defaultConfigDir(), {
				all: opts.all,
				...(opts.olderThan !== undefined ? { maxAgeMs: opts.olderThan * 3600_000 } : {})
			});
			if (opts.json) return printJson({ items: removed });
			for (const entry of removed) console.log(`removed ${entry.path}`);
			console.log(`pruned ${removed.length} kept workspace${removed.length === 1 ? '' : 's'}`);
		});

	// --- runs --------------------------------------------------------------------

	const runsCmd = program.command('runs').description('Agent runs: attempts at issues by runners');

	withList(
		runsCmd
			.command('list')
			.description('List runs, newest first')
			.option('-i, --issue <ref>', 'filter to one issue (<project>/<number>)')
			.option('-r, --runner <name>', 'filter by runner name')
			.option('--active', 'only runs holding a claim (assigned/launching/running)')
			.addOption(
				new Option('--population <mode>', 'period evidence population').choices([
					'finalized',
					'pending'
				])
			)
			.option('--from <timestamp>', 'inclusive period start')
			.option('--to <timestamp>', 'exclusive period cutoff')
			.option('--timezone <iana>', 'period display timezone (with --timezone-source)')
			.option('--timezone-source <source>', 'supervisor_budget or utc_fallback')
			.option('--project <name-or-id>', 'project, including archived')
			.option('--workflow <name-or-id>', 'workflow')
			.option('--state <id>', 'starting state id')
			.option('--tier <tier>', 'model tier')
			.addOption(
				new Option('--outcome <outcome>', 'recorded outcome').choices([
					'advanced',
					'stalled',
					'interrupted',
					'unknown'
				])
			)
			.addOption(
				new Option('--accounting-status <status>', 'usage accounting status').choices([
					'priced',
					'unpriced',
					'unreported'
				])
			)
	).action(async (opts: ListOpts & { issue?: string; runner?: string; active?: boolean }) => {
		const api = client(opts);
		const evidence = opts as ListOpts & {
			population?: 'finalized' | 'pending';
			from?: string;
			to?: string;
			project?: string;
			workflow?: string;
			state?: string;
			tier?: string;
			outcome?: string;
			accountingStatus?: string;
			timezone?: string;
			timezoneSource?: 'supervisor_budget' | 'utc_fallback';
		};
		if ((evidence.from === undefined) !== (evidence.to === undefined))
			die('--from and --to are required together');
		if ((evidence.from || evidence.to) && !evidence.population)
			die('period filters require --population');
		if ((evidence.timezone === undefined) !== (evidence.timezoneSource === undefined))
			die('--timezone and --timezone-source are required together');
		if (evidence.population && opts.limit !== undefined && opts.limit > 100)
			die('period evidence --limit must be at most 100');
		const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
		const runnerId = opts.runner
			? evidence.population && isUsageIdentity(opts.runner, 'rnr')
				? opts.runner
				: (await resolveRunner(api, opts.runner)).id
			: undefined;
		const projectId = evidence.project
			? evidence.population && isUsageIdentity(evidence.project, 'prj')
				? evidence.project
				: (await resolveProject(api, evidence.project)).id
			: undefined;
		const workflowId = evidence.workflow
			? evidence.population && isUsageIdentity(evidence.workflow, 'wf')
				? evidence.workflow
				: (await resolveWorkflow(api, evidence.workflow)).id
			: undefined;
		const res = await fetchList(opts, (page) =>
			api.listRuns({
				issue: issueId,
				runner: runnerId,
				active: opts.active ? true : undefined,
				population: evidence.population,
				from: evidence.from,
				to: evidence.to,
				project: projectId,
				workflow: workflowId,
				state: evidence.state,
				tier: evidence.tier,
				outcome: evidence.outcome as never,
				accounting_status: evidence.accountingStatus as never,
				timezone: evidence.timezone,
				timezone_source: evidence.timezoneSource,
				...page
			})
		);
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log(opts.active ? 'no active runs' : 'no runs');
			if (evidence.population === 'pending') {
				table([
					['ID', 'ISSUE', 'RUNNER', 'TIER', 'STATUS', 'COST', 'CREATED'],
					...(items as unknown as UsagePendingRun[]).map((run) => [
						run.id,
						run.issue_ref ? `${run.issue_ref.project_name}/${run.issue_ref.number}` : run.issue_id,
						run.runner_name,
						run.tier,
						'Pending at cutoff',
						'—',
						timestamp(run.created_at)
					])
				]);
				return;
			}
			table([
				['ID', 'ISSUE', 'RUNNER', 'TIER', 'STATUS', 'DURATION', 'COST', 'CREATED'],
				...items.map(runRow)
			]);
			if (evidence.population === 'finalized')
				for (const run of items)
					if (run.usage_dimensions && run.usage_accounting)
						for (const line of usageEvidenceLines(
							run.id,
							run.usage_dimensions,
							run.usage_accounting
						))
							console.log(line);
		});
	});

	withCommon(
		runsCmd
			.command('show <id>')
			.description('Show a run; --logs prints the captured log tail, --logs --full the whole log')
			.option('--logs', 'print the log tail')
			.option('--full', 'with --logs: print the complete log, not the 256 KB tail')
			.option('--raw', 'with --logs --full: print the unrendered harness stream instead')
	).action(
		async (id: string, opts: CommonOpts & { logs?: boolean; full?: boolean; raw?: boolean }) => {
			const api = client(opts);
			const run = await api.getRun(id);
			if (opts.json) return printJson(run);
			console.log(
				`${run.id}  ${run.status}  on ${run.runner_name}${run.resumed_from_run_id ? `  · resumed run ${run.resumed_from_run_id}` : ''}`
			);
			if (run.issue_ref) console.log(`issue: ${issueRef(run.issue_ref)} — ${run.issue_ref.title}`);
			console.log(`tier: ${run.tier}  model: ${run.model ?? '(n/a)'}`);
			const effortSource = run.effort_source;
			const sourceLabel =
				effortSource?.kind === 'routing_target'
					? `routing target ${effortSource.target_index + 1} (${effortSource.scope_label})`
					: effortSource?.kind === 'runner_tier'
						? `runner tier ${effortSource.tier}`
						: effortSource?.kind === 'none'
							? 'provider default'
							: 'legacy record';
			const evidence = run.effort_application_evidence as {
				milestones?: Array<{ observed_model?: string; observed_effort?: string; reason?: string }>;
			} | null;
			const observed = evidence?.milestones?.findLast(
				(item) => item.observed_model !== undefined || item.observed_effort !== undefined
			);
			console.log(
				`effort: requested ${run.requested_effort ?? '(none)'}  resolved ${run.resolved_effort ?? '(provider default)'}  source ${sourceLabel}`
			);
			console.log(
				`effort application: ${(run.effort_application_status ?? 'unknown').replaceAll('_', ' ')}${observed ? `  observed ${observed.observed_effort ?? '(unknown effort)'} on ${observed.observed_model ?? '(unknown model)'}` : '  observed unknown'}${observed?.reason ? `  (${observed.reason})` : ''}`
			);
			console.log(
				`states: ${run.state_at_start_name ?? run.state_id_at_start} → ${run.state_at_end_name ?? run.state_id_at_end ?? '…'}`
			);
			console.log(
				`created: ${timestamp(run.created_at)}  started: ${run.started_at ? timestamp(run.started_at) : '—'}  ended: ${run.ended_at ? timestamp(run.ended_at) : '—'}  duration: ${runDurationLabel(run)}`
			);
			if (run.usage) {
				const u = run.usage;
				const costLabel = runCostLabel(run);
				const metric = (value: number | undefined) =>
					value === undefined ? 'unknown' : value.toLocaleString();
				console.log(
					`usage: input ${metric(u.input_tokens)}  cache-read ${metric(u.cache_read_tokens)}  cache-write ${metric(u.cache_write_tokens)}  output ${metric(u.output_tokens)}`
				);
				if (u.cost_usd !== undefined)
					console.log(
						`cost: ${runCostLabel(run)}${u.cost_source === undefined ? ' · source unavailable' : ''}`
					);
				const pricing = u.pricing;
				if (pricing?.status === 'provider_authoritative')
					console.log('cost provenance: provider-reported amount is authoritative');
				if (pricing?.status === 'unpriced') console.log(`cost: Unpriced (${pricing.reason})`);
				else if (u.cost_usd === undefined && costLabel === 'Unpriced')
					console.log('cost: Unpriced');
				if (pricing?.status === 'calculated') {
					const b = pricing.basis;
					console.log(`cost provenance: Estimated standard API list-price equivalent`);
					console.log(`  model: ${b.model} (${b.model_identity})`);
					console.log(
						`  rate: ${b.rate_id} v${b.rate_version}; adopted ${new Date(b.rate_adopted_at).toISOString()}`
					);
					console.log(
						`  source: ${b.source_url} (checked ${b.source_checked_at}${b.source_effective_at ? `; effective ${b.source_effective_at}` : ''})`
					);
					console.log(
						`  rates USD/1M: input ${b.rates.input_tokens}  cache-read ${b.rates.cache_read_tokens}  cache-write ${b.rates.cache_write_tokens ?? 'unpublished'}  output ${b.rates.output_tokens}`
					);
					console.log(`  exact estimated USD: ${b.cost_usd_exact}`);
					console.log('  Standard API list-price estimate; not an invoice or subscription usage.');
				}
				const proof = pricing?.evidence?.request_context;
				if (proof?.status === 'complete') {
					console.log(
						`request context: ${proof.request_count.toLocaleString()} verified · largest input ${proof.max_request_input_tokens.toLocaleString()} · Codex ${proof.harness_version} · ${proof.normalization}`
					);
				} else if (proof) {
					console.log(
						`request context: ${proof.status} (${proof.reason})${proof.harness_version ? ` · Codex ${proof.harness_version}` : ''} · ${proof.normalization}`
					);
				}
			}
			if (run.provider_session_id) console.log(`provider session: ${run.provider_session_id}`);
			if (run.provider_url) console.log(`provider console: ${run.provider_url}`);
			if (run.error) console.log(`error: ${run.error}`);
			if (opts.logs) {
				console.log('');
				if (opts.full || opts.raw) {
					// Streamed to stdout: a full log runs to megabytes, and there is
					// no reason to hold one in memory to print it.
					const res = await api.getRunLogFull(id, { raw: opts.raw });
					const body = res.body;
					if (!body) return;
					const reader = body.getReader();
					const decoder = new TextDecoder();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (value) process.stdout.write(decoder.decode(value, { stream: true }));
					}
					process.stdout.write(decoder.decode());
					return;
				}
				if (run.log_bytes_dropped > 0) {
					console.log(
						`[${Math.round(run.log_bytes_dropped / 1024)} KB truncated from the head — ` +
							(run.log_expired
								? 'past its retention window; only this tail remains]'
								: `run \`tines runs show ${run.id} --logs --full\` for the complete ${Math.round(run.log_full_bytes / 1024)} KB log]`)
					);
				}
				console.log(run.log || '(no log output captured)');
			}
		}
	);

	withCommon(
		runsCmd
			.command('cancel <id>')
			.description('Cancel a run (judged like any other end: usually a strike)')
	).action(async (id: string, opts: CommonOpts) => {
		const api = client(opts);
		const run = await api.cancelRun(id);
		if (opts.json) return printJson(run);
		console.log(
			`canceled ${run.id}${run.issue_ref ? ` on ${issueRef(run.issue_ref)}` : ''} (was on ${run.runner_name})`
		);
	});
}
