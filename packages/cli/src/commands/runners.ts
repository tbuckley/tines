/** `tines runners` / `runner` / `runs` — the runner registry, the local daemon, and agent runs. */
import { hostname } from 'node:os';
import {
	client,
	die,
	fetchList,
	printJson,
	printList,
	resolveApiKey,
	resolveIssue,
	resolveRunner,
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
import {
	HARNESS_KINDS,
	KEEP_WORKSPACES_MODES,
	type HarnessKind,
	type KeepWorkspacesMode
} from '../daemon/support.js';
import { issueRef, keptWorkspaceRow, runRow, runnerStatusLabel, timestamp } from '../format.js';
import {
	isStaleTierOverride,
	MODEL_TIERS,
	runDurationLabel,
	type ModelTier,
	type Runner,
	type UpdateRunnerRequest
} from '@tines/shared';
import type { Command } from 'commander';

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
				['NAME', 'TYPE', 'STATUS', 'RUNS', 'TIER', 'LAST SEEN'],
				...res.items.map((r) => [
					r.name,
					r.type,
					runnerStatusLabel(r),
					`${r.active_runs}/${r.max_concurrent}`,
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
			if (runner.last_seen_at) console.log(`last seen: ${timestamp(runner.last_seen_at)}`);
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
		runnerCmd
			.command('daemon')
			.description(
				'Run the local runner daemon: register/reconnect, poll for assigned runs, execute them'
			)
			.option(
				'--name <name>',
				'runner name, unique per user; name it machine-plus-harness, e.g. macbook-claude (default: this hostname)'
			)
			.option('--harness <harness>', 'claude-code | codex | custom', 'claude-code')
			.option(
				'--command <template>',
				'custom harness command template ({prompt_file}, {workspace}, {model})'
			)
			.option('--max-concurrent <n>', 'maximum simultaneous runs', (v) => Number.parseInt(v, 10), 1)
			.option(
				'--poll-interval <seconds>',
				'seconds between polls',
				(v) => Number.parseInt(v, 10),
				15
			)
			.option(
				'--no-cli-refresh',
				'do not install/refresh the agent-facing tines CLI from npm (harnesses use the ambient PATH)'
			)
			.option(
				'--no-self-update',
				'do not exit for the service manager to relaunch a newer daemon (only applies when launched from the daemon-managed prefix)'
			)
			.option(
				'--keep-workspaces <mode>',
				"keep settled runs' workspaces for debugging: never | failed | always",
				'never'
			)
			.option(
				'--keep-workspaces-for <hours>',
				'delete kept workspaces older than this',
				(v) => Number(v),
				72
			)
			.option(
				'--keep-workspaces-max <n>',
				'keep at most this many workspaces (oldest removed first)',
				(v) => Number.parseInt(v, 10),
				20
			)
	).action(
		async (
			opts: CommonOpts & {
				name?: string;
				harness: string;
				command?: string;
				maxConcurrent: number;
				pollInterval: number;
				cliRefresh: boolean;
				selfUpdate: boolean;
				keepWorkspaces: string;
				keepWorkspacesFor: number;
				keepWorkspacesMax: number;
			}
		) => {
			const harness = opts.harness.replaceAll('-', '_') as HarnessKind;
			if (!HARNESS_KINDS.includes(harness)) {
				die(`--harness must be claude-code, codex, or custom, got "${opts.harness}"`);
			}
			if (harness === 'custom' && !opts.command) {
				die(
					'the custom harness needs --command "<template>" ({prompt_file}, {workspace}, {model})'
				);
			}
			if (harness !== 'custom' && opts.command) die('--command only applies to --harness custom');
			if (
				!Number.isInteger(opts.maxConcurrent) ||
				opts.maxConcurrent < 1 ||
				opts.maxConcurrent > 100
			) {
				die('--max-concurrent must be an integer between 1 and 100');
			}
			if (!Number.isInteger(opts.pollInterval) || opts.pollInterval < 1) {
				die('--poll-interval must be a positive number of seconds');
			}
			const keepWorkspaces = opts.keepWorkspaces as KeepWorkspacesMode;
			if (!KEEP_WORKSPACES_MODES.includes(keepWorkspaces)) {
				die(
					`--keep-workspaces must be ${KEEP_WORKSPACES_MODES.join(', ')}, got "${opts.keepWorkspaces}"`
				);
			}
			if (!Number.isFinite(opts.keepWorkspacesFor) || opts.keepWorkspacesFor <= 0) {
				die('--keep-workspaces-for must be a positive number of hours');
			}
			if (!Number.isInteger(opts.keepWorkspacesMax) || opts.keepWorkspacesMax < 1) {
				die('--keep-workspaces-max must be a positive integer');
			}
			await runDaemon({
				url: resolveUrl(opts).replace(/\/+$/, ''),
				apiKey: resolveApiKey(opts),
				name: opts.name ?? hostname(),
				harness,
				command: opts.command,
				maxConcurrent: opts.maxConcurrent,
				pollIntervalMs: opts.pollInterval * 1000,
				configDir: defaultConfigDir(),
				cliRefresh: opts.cliRefresh,
				selfUpdate: opts.selfUpdate,
				keepWorkspaces,
				keepWorkspacesForHours: opts.keepWorkspacesFor,
				keepWorkspacesMax: opts.keepWorkspacesMax
			});
		}
	);

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
	).action(async (opts: ListOpts & { issue?: string; runner?: string; active?: boolean }) => {
		const api = client(opts);
		const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
		const runnerId = opts.runner ? (await resolveRunner(api, opts.runner)).id : undefined;
		const res = await fetchList(opts, (page) =>
			api.listRuns({
				issue: issueId,
				runner: runnerId,
				active: opts.active ? true : undefined,
				...page
			})
		);
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log(opts.active ? 'no active runs' : 'no runs');
			table([
				['ID', 'ISSUE', 'RUNNER', 'TIER', 'STATUS', 'DURATION', 'COST', 'CREATED'],
				...items.map(runRow)
			]);
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
			console.log(`${run.id}  ${run.status}  on ${run.runner_name}`);
			if (run.issue_ref) console.log(`issue: ${issueRef(run.issue_ref)} — ${run.issue_ref.title}`);
			console.log(`tier: ${run.tier}  model: ${run.model ?? '(n/a)'}`);
			console.log(
				`states: ${run.state_at_start_name ?? run.state_id_at_start} → ${run.state_at_end_name ?? run.state_id_at_end ?? '…'}`
			);
			console.log(
				`created: ${timestamp(run.created_at)}  started: ${run.started_at ? timestamp(run.started_at) : '—'}  ended: ${run.ended_at ? timestamp(run.ended_at) : '—'}  duration: ${runDurationLabel(run)}`
			);
			if (run.usage) {
				const u = run.usage;
				const parts: string[] = [];
				if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
					parts.push(
						`${(u.input_tokens ?? 0).toLocaleString()} in / ${(u.output_tokens ?? 0).toLocaleString()} out tokens`
					);
				}
				if (u.cost_usd !== undefined) parts.push(`$${u.cost_usd.toFixed(2)}`);
				if (u.cost_source)
					parts.push(`(${u.cost_source === 'provider' ? 'provider-reported' : u.cost_source})`);
				if (parts.length > 0) console.log(`usage: ${parts.join('  ')}`);
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
