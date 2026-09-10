/**
 * The Claude managed-runner adapter: Anthropic Managed Agents sessions
 * (SPEC.md "Workspace setup and launch", `claude_managed`).
 *
 * Provisioning is lazy — the environment and per-tier agent objects are
 * created on a tier's first launch and cached in the runner's config, each
 * agent stored with the model it was provisioned for so a moved tier
 * re-provisions instead of silently freezing. Repos mount as
 * `github_repository` session resources (Anthropic's git proxy injects the
 * PAT outside the sandbox); the run key travels as a per-run vault
 * `environment_variable` credential substituted at egress. The per-run cost
 * cap maps to the session's platform-enforced `budget.max_list_cost`.
 *
 * Launch materials (issue, prompt, context bundle) are fetched from our own
 * API over HTTP with the run key: this module is bundled into the worker
 * (Kit-free — no `$lib`, no api/ imports), and the run key already carries
 * exactly the authority the launch needs.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import {
	type EffectiveContext,
	type IssueDetail,
	type LaunchPromptResponse,
	type ModelTier,
	type RunnerBudget,
	type Runner,
	type RunnerTierOverrides,
	canonicalGitHubRepoUrl,
	LAUNCH_STALL_MS
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import { decryptSecret } from '../crypto';
import { getDb, newId, type Database } from '../db';
import type {
	AdapterEndInput,
	AdapterLaunchInput,
	AdapterLaunchResult,
	AdapterPollResult,
	AdapterRunRef,
	RunnerAdapter
} from './adapter';
import { mapUsage, summarizeEvents } from './claude-events';
import {
	claimResourceDisposal,
	isResumeProviderSupported,
	prepareManagedResume,
	resumeFingerprint,
	retainResumeResource,
	setTransferPhase
} from './resume';
import { buildResumePreamble, buildSupervisorPreamble } from './preamble';

// ---------------------------------------------------------------------------
// Config shapes (runner.config / agent_run.provider_meta are adapter-owned)

/** `runner.config` for `claude_managed` — Tines-managed, not user-edited. */
export interface ClaudeRunnerConfig {
	/** Lazily provisioned managed environment (cloud, unrestricted egress). */
	environment_id?: string;
	/** Per-tier managed agents, each with the model/effort it was built for. */
	agents?: Partial<Record<ModelTier, { agent_id: string; model: string; effort?: string }>>;
}

/** `agent_run.provider_meta` for Claude runs. */
export interface ClaudeRunMeta {
	/** The per-run vault holding the TINES_API_KEY credential. */
	vault_id?: string;
	/** `processed_at` of the newest session event already rendered to the log. */
	events_cursor?: string;
	/** The credential inside `vault_id` holding the run key, for rotation. */
	credential_id?: string;
	/** Set once end-of-run provider resources were garbage-collected. */
	gc_done?: boolean;
	/**
	 * Set when the end finalizer retained this run's session for a resume:
	 * the session is deliberately left idle and its vault alive, so the GC
	 * below must not treat it as an ended run's leftovers. Retention itself
	 * lives in `run_resource`; this flag is what makes the provider-side
	 * sweep agree with it without a join.
	 */
	retained?: boolean;
}

export interface ClaudeAdapterOptions {
	/** Injected in unit tests; reaches both the SDK client and self-API GETs. */
	fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Environment plumbing

function requireEncryptionKey(env: Env): string {
	if (!env.SECRET_ENCRYPTION_KEY) {
		throw new Error(
			'SECRET_ENCRYPTION_KEY is not configured; cannot use stored provider credentials'
		);
	}
	return env.SECRET_ENCRYPTION_KEY;
}

/**
 * Canonicalizes a repo context item's URL to the one form the Managed
 * Agents API accepts for `github_repository` resources. The shared
 * implementation (artifact `pr` references canonicalize identically) is
 * re-exported so this module stays the adapter-side import site.
 */
export { canonicalGitHubRepoUrl } from '@tines/shared';

/** The public base URL managed runs use to reach the Tines API. */
export function tinesApiBaseUrl(env: Env): string {
	const base = env.TINES_PUBLIC_URL ?? env.BETTER_AUTH_URL;
	if (!base) {
		throw new Error(
			'Cannot determine the public Tines URL (set TINES_PUBLIC_URL or BETTER_AUTH_URL); managed runs need it to reach the API'
		);
	}
	return base.replace(/\/+$/, '');
}

function anthropic(apiKey: string, opts: ClaudeAdapterOptions): Anthropic {
	return new Anthropic({ apiKey, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

/**
 * Validates a pasted Anthropic key with a cheap authenticated call before
 * anything is stored (USER_FLOWS.md flow 3). Returns null when the key
 * works; a human-readable failure otherwise.
 */
export async function pingAnthropicKey(
	apiKey: string,
	opts: ClaudeAdapterOptions = {}
): Promise<string | null> {
	try {
		await anthropic(apiKey, opts).beta.agents.list({ limit: 1 });
		return null;
	} catch (e) {
		if (e instanceof Anthropic.APIError) {
			if (e.status === 401) return 'Anthropic rejected the API key (401)';
			if (e.status === 403) {
				return 'The API key is valid but not permitted to use Managed Agents (403)';
			}
			return `Anthropic returned ${e.status ?? 'an error'} validating the key: ${e.message}`;
		}
		return `Could not reach the Anthropic API: ${e instanceof Error ? e.message : String(e)}`;
	}
}

// ---------------------------------------------------------------------------
// The adapter

interface RunnerContext {
	row: Database['runner'];
	config: ClaudeRunnerConfig;
	client: Anthropic;
}

function parseJson<T>(raw: string | null | undefined): T | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Provider context: everything bound to one worker env

/**
 * Provider/session plumbing bound to one worker env: DB access, key
 * decryption, the SDK client, self-API GETs and lazy provisioning. Built once
 * per adapter so the `RunnerAdapter` surface below is just launch/poll/cancel/
 * sweep wired to a named unit instead of seven anonymous nested functions.
 */
interface ProviderContext {
	db: Kysely<Database>;
	runnerContext(runnerId: string): Promise<RunnerContext>;
	/** The stored PAT, decrypted; null when none is configured. */
	githubPat(userId: string): Promise<string | null>;
	apiGet<T>(base: string, path: string, runKey: string): Promise<T>;
	ensureEnvironment(ctx: RunnerContext): Promise<string>;
	ensureTierAgent(
		ctx: RunnerContext,
		tier: ModelTier,
		model: string,
		effort: string | undefined
	): Promise<string>;
	createRunVault(
		ctx: RunnerContext,
		runId: string,
		runKey: string,
		apiHost: string
	): Promise<{ vaultId: string; credentialId: string }>;
}

function createProviderContext(env: Env, opts: ClaudeAdapterOptions): ProviderContext {
	const db = getDb(env);
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);

	async function runnerContext(runnerId: string): Promise<RunnerContext> {
		const row = await db
			.selectFrom('runner')
			.selectAll()
			.where('id', '=', runnerId)
			.executeTakeFirst();
		if (!row) throw new Error(`runner ${runnerId} not found`);
		if (!row.secret_enc) throw new Error(`runner ${row.name} has no provider API key stored`);
		const apiKey = await decryptSecret(row.secret_enc, requireEncryptionKey(env));
		return {
			row,
			config: parseJson<ClaudeRunnerConfig>(row.config) ?? {},
			client: anthropic(apiKey, opts)
		};
	}

	/** The stored PAT, decrypted; null when none is configured. */
	async function githubPat(userId: string): Promise<string | null> {
		const settings = await db
			.selectFrom('supervisor_settings')
			.select('github_pat_enc')
			.where('user_id', '=', userId)
			.executeTakeFirst();
		if (!settings?.github_pat_enc) return null;
		return decryptSecret(settings.github_pat_enc, requireEncryptionKey(env));
	}

	async function persistConfig(runnerId: string, config: ClaudeRunnerConfig): Promise<void> {
		await db
			.updateTable('runner')
			.set({
				config: JSON.stringify(config),
				resume_config_revision: sql<number>`resume_config_revision + 1`
			})
			.where('id', '=', runnerId)
			.execute();
	}

	/**
	 * GET against our own API with the run key (self-seeding's own
	 * mechanism). Prefers the SELF service binding — it invokes this worker's
	 * fetch handler in-process, which is the only way to reach ourselves in
	 * production: a worker on a custom domain cannot `fetch()` its own
	 * hostname (Cloudflare routes that to the nonexistent origin → 522). A
	 * thrown SELF call falls back to plain fetch for dev setups where the
	 * binding doesn't resolve; HTTP error statuses are real API answers and
	 * propagate.
	 */
	async function apiGet<T>(base: string, path: string, runKey: string): Promise<T> {
		const url = `${base}${path}`;
		const init = { headers: { authorization: `Bearer ${runKey}` } };
		let res: Response;
		if (opts.fetch) {
			res = await opts.fetch(url, init);
		} else if (env.SELF) {
			res = (await env.SELF.fetch(url, init).catch(() => fetchFn(url, init))) as Response;
		} else {
			res = await fetchFn(url, init);
		}
		if (!res.ok) throw new Error(`launch materials fetch failed: GET ${path} → ${res.status}`);
		return res.json() as Promise<T>;
	}

	/** The managed environment, created on first use and cached in config. */
	async function ensureEnvironment(ctx: RunnerContext): Promise<string> {
		if (ctx.config.environment_id) return ctx.config.environment_id;
		const name = `tines-${ctx.row.id}`;
		let environmentId: string;
		try {
			const created = await ctx.client.beta.environments.create({
				name,
				description: `Tines workspace for runner "${ctx.row.name}"`,
				config: { type: 'cloud', networking: { type: 'unrestricted' } }
			});
			environmentId = created.id;
		} catch (e) {
			// 409 = the name exists (a previous launch lost the config write);
			// recover it by name instead of failing the launch.
			if (!(e instanceof Anthropic.APIError && e.status === 409)) throw e;
			const page = await ctx.client.beta.environments.list({ limit: 100 });
			const existing = page.data.find((envr) => envr.name === name);
			if (!existing) throw e;
			environmentId = existing.id;
		}
		ctx.config.environment_id = environmentId;
		await persistConfig(ctx.row.id, ctx.config);
		return environmentId;
	}

	/**
	 * The tier's managed agent, provisioned on first use and re-provisioned
	 * when the tier resolves differently than it was built for (the
	 * anti-drift rule: tiers never silently freeze). The agent object stays
	 * minimal — default toolset, no directive system prompt; all direction
	 * lives in the per-session launch prompt.
	 */
	async function ensureTierAgent(
		ctx: RunnerContext,
		tier: ModelTier,
		model: string,
		effort: string | undefined
	): Promise<string> {
		const modelParam = effort
			? { id: model, effort: effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
			: model;
		const existing = ctx.config.agents?.[tier];
		if (existing && existing.model === model && existing.effort === effort) {
			return existing.agent_id;
		}
		let agentId: string;
		if (existing) {
			await ctx.client.beta.agents.update(existing.agent_id, { model: modelParam });
			agentId = existing.agent_id;
		} else {
			const created = await ctx.client.beta.agents.create({
				name: `tines-${ctx.row.name}-${tier}`,
				description: `Tines runner "${ctx.row.name}", tier ${tier}`,
				model: modelParam,
				tools: [{ type: 'agent_toolset_20260401' }]
			});
			agentId = created.id;
		}
		ctx.config.agents = {
			...ctx.config.agents,
			[tier]: { agent_id: agentId, model, ...(effort ? { effort } : {}) }
		};
		await persistConfig(ctx.row.id, ctx.config);
		return agentId;
	}

	/** The per-run vault holding the agent's TINES_API_KEY, substituted at egress. */
	async function createRunVault(
		ctx: RunnerContext,
		runId: string,
		runKey: string,
		apiHost: string
	): Promise<{ vaultId: string; credentialId: string }> {
		const vault = await ctx.client.beta.vaults.create({
			display_name: `tines-run-${runId}`,
			metadata: { tines_run_id: runId }
		});
		try {
			const credential = await ctx.client.beta.vaults.credentials.create(vault.id, {
				display_name: `Tines run key for ${runId}`,
				auth: {
					type: 'environment_variable',
					secret_name: 'TINES_API_KEY',
					secret_value: runKey,
					networking: { type: 'limited', allowed_hosts: [apiHost] },
					// The CLI sends the key as an Authorization header; body
					// substitution would only widen the exposure surface.
					injection_location: { header: true }
				}
			});
			return { vaultId: vault.id, credentialId: credential.id };
		} catch (e) {
			await ctx.client.beta.vaults.delete(vault.id).catch(() => {});
			throw e;
		}
	}

	// `persistConfig` stays private: only the two ensure* functions write config.
	return {
		db,
		runnerContext,
		githubPat,
		apiGet,
		ensureEnvironment,
		ensureTierAgent,
		createRunVault
	};
}

// ---------------------------------------------------------------------------
// Sweep housekeeping: GC ended runs' provider resources; cancel orphans
//
// Each block below closes over nothing but the DB handle and the runner's SDK
// client, so they live at module scope and `sweepRunner` is the runner-context
// guard plus three calls.

/**
 * The sessions this runner is deliberately holding for a resume: every
 * managed resource that is still claimable (`available`) or mid-transfer
 * (`claimed`). Both provider-side sweeps below consult it before deciding
 * that an ended run's session is garbage — retention is precisely the state
 * where a session outlives its run.
 */
/**
 * Expiry GC, provider side: an expired managed resource is claimed for
 * disposal through the same `available →` predicate a reuse would use (so a
 * launch in flight keeps its session), then its session is archived and its
 * vault deleted before the row goes. A failed provider call leaves the row
 * in `disposing` for the next sweep rather than dropping the only record of
 * the handles.
 */
async function disposeExpiredManagedResources(
	db: Kysely<Database>,
	client: Anthropic,
	runnerId: string,
	now: number
): Promise<void> {
	const expired = await db
		.selectFrom('run_resource')
		.selectAll()
		.where('runner_id', '=', runnerId)
		.where('kind', '=', 'claude_managed')
		.where('state', '=', 'available')
		.where('expires_at', '<=', now)
		.orderBy('expires_at asc')
		.limit(25)
		.execute();
	for (const row of expired) {
		if (!(await claimResourceDisposal(db, row.id, now))) continue;
		try {
			if (row.provider_session_id) {
				await client.beta.sessions.archive(row.provider_session_id).catch((e) => {
					if (!(e instanceof Anthropic.APIError && e.status === 404)) throw e;
				});
			}
			if (row.vault_id) {
				await client.beta.vaults.delete(row.vault_id).catch((e) => {
					if (!(e instanceof Anthropic.APIError && e.status === 404)) throw e;
				});
			}
			await db.deleteFrom('run_resource').where('id', '=', row.id).execute();
		} catch (e) {
			console.error(`claude sweep: disposing resume resource ${row.id} failed:`, e);
		}
	}
}

async function retainedSessionIds(db: Kysely<Database>, runnerId: string): Promise<Set<string>> {
	const rows = await db
		.selectFrom('run_resource')
		.select('provider_session_id')
		.where('runner_id', '=', runnerId)
		.where('kind', '=', 'claude_managed')
		.where('state', 'in', ['available', 'claimed'])
		.execute();
	return new Set(rows.map((r) => r.provider_session_id).filter((id): id is string => !!id));
}

async function gcEndedRuns(
	db: Kysely<Database>,
	client: Anthropic,
	runnerId: string
): Promise<void> {
	// GC: ended runs whose per-run vault (and session) still exist. The
	// vault holds an already-revoked key, but it must not accumulate.
	const ended = await db
		.selectFrom('agent_run')
		.select(['id', 'provider_session_id', 'provider_meta'])
		.where('runner_id', '=', runnerId)
		.where('status', 'not in', ['assigned', 'launching', 'running'])
		.where('provider_meta', 'is not', null)
		.orderBy('ended_at desc')
		.limit(25)
		.execute();
	const retained = await retainedSessionIds(db, runnerId);
	for (const run of ended) {
		const meta = parseJson<ClaudeRunMeta>(run.provider_meta);
		if (!meta || meta.gc_done) continue;
		// A retained run's session and vault are the resume path's, not
		// leftovers: only the resource's disposal (expiry, or a reuse that
		// ends) may delete them.
		if (meta.retained && run.provider_session_id && retained.has(run.provider_session_id)) continue;
		try {
			if (meta.vault_id) {
				await client.beta.vaults.delete(meta.vault_id).catch((e) => {
					if (!(e instanceof Anthropic.APIError && e.status === 404)) throw e;
				});
			}
			if (run.provider_session_id) {
				await client.beta.sessions.archive(run.provider_session_id).catch(() => {});
			}
			await db
				.updateTable('agent_run')
				.set({ provider_meta: JSON.stringify({ ...meta, gc_done: true }) })
				.where('id', '=', run.id)
				.execute();
		} catch (e) {
			console.error(`claude sweep: GC for run ${run.id} failed:`, e);
		}
	}
}

async function reconcileVaults(
	db: Kysely<Database>,
	client: Anthropic,
	runnerId: string
): Promise<void> {
	// Vault fallback sweep, by name: a run canceled between vault creation
	// and the running-flip never records `provider_meta`, so the GC above
	// cannot see its vault. Per-run vaults are named `tines-run-<id>`,
	// which makes them findable regardless — delete any whose run is
	// unknown or ended.
	try {
		const vaults = await client.beta.vaults.list({ limit: 100 });
		for (const vault of vaults.data) {
			const runId = vault.display_name?.startsWith('tines-run-')
				? vault.display_name.slice('tines-run-'.length)
				: null;
			if (!runId) continue; // not ours — never touch foreign vaults
			const run = await db
				.selectFrom('agent_run')
				.select(['id', 'status', 'created_at'])
				.where('id', '=', runId)
				.executeTakeFirst();
			if (run && ['assigned', 'launching', 'running'].includes(run.status)) continue;
			// A vault whose run row is missing entirely could be an in-flight
			// launch racing this sweep (vault created, claim row… no — the
			// claim precedes the vault). Missing = deleted runner history.
			await client.beta.vaults.delete(vault.id).catch(() => {});
		}
	} catch (e) {
		console.error(`claude sweep: vault reconciliation for runner ${runnerId} failed:`, e);
	}
}

async function reconcileSessions(
	db: Kysely<Database>,
	client: Anthropic,
	runnerId: string,
	now: number
): Promise<void> {
	// Launch reconciliation, provider side: live sessions tagged with a run
	// id that is unknown or already ended are orphans (a crash between
	// session create and the DB write) — cancel them. Freshly created
	// sessions get the launch-stall grace period before qualifying.
	try {
		const retained = await retainedSessionIds(db, runnerId);
		const page = await client.beta.sessions.list({
			statuses: ['running', 'idle', 'rescheduling'],
			limit: 100
		});
		for (const session of page.data) {
			const runId = session.metadata?.tines_run_id;
			if (!runId) continue; // not ours — never touch foreign sessions
			if (now - Date.parse(session.created_at) < LAUNCH_STALL_MS) continue;
			// An idle session held by a live resource is retained on purpose:
			// its owner run HAS ended, which is exactly what this sweep would
			// otherwise read as an orphan.
			if (retained.has(session.id)) continue;
			const run = await db
				.selectFrom('agent_run')
				.select(['id', 'status'])
				.where('id', '=', runId)
				.executeTakeFirst();
			if (run && ['assigned', 'launching', 'running'].includes(run.status)) continue;
			await client.beta.sessions.events
				.send(session.id, { events: [{ type: 'user.interrupt' }] })
				.catch(() => {});
			await client.beta.sessions.archive(session.id).catch(() => {});
		}
	} catch (e) {
		console.error(`claude sweep: session reconciliation for runner ${runnerId} failed:`, e);
	}
}

// ---------------------------------------------------------------------------
// The adapter surface

export function createClaudeAdapter(env: Env, opts: ClaudeAdapterOptions = {}): RunnerAdapter {
	const provider = createProviderContext(env, opts);
	const db = provider.db;

	async function launch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
		const ctx = await provider.runnerContext(input.runner.id);
		const base = tinesApiBaseUrl(env);
		const apiHost = new URL(base).hostname;
		if (!input.model) throw new Error('Claude launches need a resolved model for the tier');
		const overrides = parseJson<RunnerTierOverrides>(ctx.row.tiers);
		const effort = overrides?.[input.tier]?.effort;

		// Launch materials, assembled at launch time over our own API.
		const [issue, prompt, context] = await Promise.all([
			provider.apiGet<IssueDetail>(base, `/api/v1/issues/${input.issueId}`, input.runKey),
			provider.apiGet<LaunchPromptResponse>(
				base,
				`/api/v1/issues/${input.issueId}/prompt`,
				input.runKey
			),
			provider.apiGet<EffectiveContext>(
				base,
				`/api/v1/issues/${input.issueId}/context`,
				input.runKey
			)
		]);
		const pat = await provider.githubPat(ctx.row.user_id);
		if (context.repos.length > 0 && !pat) {
			throw new Error(
				'No GitHub PAT is stored in supervisor settings, so this managed run cannot clone its repositories — add one on the Agents tab'
			);
		}
		// The provider accepts exactly https://github.com/{owner}/{repo} —
		// canonicalize the clone-tolerant forms context items may carry, and
		// name the offending item when the URL is not a GitHub repo at all.
		const repos = context.repos.map((repo) => {
			const canonical = canonicalGitHubRepoUrl(repo.url);
			if (!canonical) {
				throw new Error(
					`repo context item "${repo.name}" points at ${repo.url}, which is not a github.com repository URL; Claude managed runs can only mount GitHub repos`
				);
			}
			return { ...repo, url: canonical };
		});

		const issueRef = `${issue.project_name}/${issue.number}`;

		// Continuation: the idle session this issue's previous run left on this
		// runner, when every guard passes. Ownership moves to this run — the
		// vault credential is rotated to its key and the session retagged —
		// so the predecessor's revoked key can never be used again. Any
		// failure before the claim falls through to the fresh launch below.
		const resume = await prepareManagedResume(db, {
			runner: {
				id: ctx.row.id,
				type: 'claude_managed',
				config: ctx.config as Record<string, unknown>,
				resume_enabled: ctx.row.resume_enabled === 1,
				resume_window_hours: ctx.row.resume_window_hours,
				resume_max_turns: ctx.row.resume_max_turns,
				resume_max_tokens: ctx.row.resume_max_tokens,
				resume_max_cost_usd: ctx.row.resume_max_cost_usd
			},
			userId: ctx.row.user_id,
			issueId: input.issueId,
			runId: input.runId,
			model: input.model,
			now: Date.now()
		});
		if (resume) {
			const continuation = await provider.apiGet<LaunchPromptResponse>(
				base,
				`/api/v1/issues/${input.issueId}/prompt?resume=1`,
				input.runKey
			);
			const resumePreamble = buildResumePreamble({
				variant: 'claude_managed',
				runId: input.runId,
				runnerName: ctx.row.name,
				issueRef,
				timeoutMinutes: input.runner.max_run_minutes,
				apiUrl: base,
				repoDirs: repos.map((r) => r.dir),
				previousRunId: resume.previous_run_id
			});
			// Rotate first: a send the session could answer with the dead run's
			// key would attribute this run's writes to the previous one.
			await ctx.client.beta.vaults.credentials.update(resume.credential_id, {
				vault_id: resume.vault_id,
				auth: { type: 'environment_variable', secret_value: input.runKey }
			});
			await ctx.client.beta.sessions.update(resume.provider_session_id, {
				title: `Tines run ${input.runId} — ${issueRef}`,
				metadata: { tines_run_id: input.runId, tines_runner_id: ctx.row.id }
			});
			// `sending` is the recovery boundary: a crash after this point may
			// have delivered the message, so reconciliation must reconcile the
			// session rather than send again.
			await setTransferPhase(db, resume.resource_id, 'sending', Date.now());
			await ctx.client.beta.sessions.events.send(resume.provider_session_id, {
				events: [
					{
						type: 'user.message',
						content: [{ type: 'text', text: `${resumePreamble}\n\n${continuation.text}` }]
					}
				]
			});
			await setTransferPhase(db, resume.resource_id, 'accepted', Date.now());
			const resumedMeta: ClaudeRunMeta = {
				vault_id: resume.vault_id,
				credential_id: resume.credential_id,
				// Start the log after the predecessor's last rendered event, so
				// its conversation does not replay into this run's log — and so
				// its `end_turn` cannot be read as this run completing.
				...(resume.events_cursor ? { events_cursor: resume.events_cursor } : {})
			};
			return {
				provider_session_id: resume.provider_session_id,
				provider_url: `https://platform.claude.com/workspaces/default/sessions/${resume.provider_session_id}`,
				provider_meta: JSON.stringify(resumedMeta)
			};
		}

		const environmentId = await provider.ensureEnvironment(ctx);
		const agentId = await provider.ensureTierAgent(ctx, input.tier, input.model, effort);
		const { vaultId, credentialId } = await provider.createRunVault(
			ctx,
			input.runId,
			input.runKey,
			apiHost
		);

		const preamble = buildSupervisorPreamble({
			variant: 'claude_managed',
			runId: input.runId,
			runnerName: ctx.row.name,
			issueRef,
			timeoutMinutes: input.runner.max_run_minutes,
			apiUrl: base,
			repoDirs: repos.map((r) => r.dir)
		});

		const budget = parseJson<RunnerBudget>(ctx.row.budget);
		const capUsd = budget?.max_run_cost_usd;
		const capCents = capUsd !== undefined ? Math.max(1, Math.round(capUsd * 100)) : undefined;

		let session: BetaManagedAgentsSession;
		try {
			session = await ctx.client.beta.sessions.create({
				agent: agentId,
				environment_id: environmentId,
				title: `Tines run ${input.runId} — ${issueRef}`,
				// The run-id tag is what launch reconciliation keys on: a session
				// whose run is unknown or ended gets cancelled by the sweep.
				metadata: { tines_run_id: input.runId, tines_runner_id: ctx.row.id },
				vault_ids: [vaultId],
				...(capCents !== undefined
					? {
							budget: {
								type: 'limit',
								max_list_cost: { amount: String(capCents), currency: 'USD' }
							}
						}
					: {}),
				resources: repos.map((repo) => ({
					type: 'github_repository' as const,
					url: repo.url,
					authorization_token: pat as string,
					mount_path: `/workspace/${repo.dir}`,
					...(repo.branch ? { checkout: { type: 'branch' as const, name: repo.branch } } : {})
				})),
				initial_events: [
					{
						type: 'user.message',
						content: [{ type: 'text', text: `${preamble}\n\n${prompt.text}` }]
					}
				]
			});
		} catch (e) {
			// The vault is useless without its session; best-effort cleanup keeps
			// the failure from leaking provider resources (the sweep would only
			// GC vaults recorded on a run).
			await ctx.client.beta.vaults.delete(vaultId).catch(() => {});
			throw e;
		}

		const meta: ClaudeRunMeta = { vault_id: vaultId, credential_id: credentialId };
		return {
			provider_session_id: session.id,
			// Best-effort console link: correct for default-workspace keys; the
			// Console's own search locates the session otherwise.
			provider_url: `https://platform.claude.com/workspaces/default/sessions/${session.id}`,
			provider_meta: JSON.stringify(meta)
		};
	}

	// -------------------------------------------------------------------------
	// Polling: session status + usage + a rendered event summary for the log

	async function poll(run: AdapterRunRef): Promise<AdapterPollResult> {
		if (!run.provider_session_id) return {};
		const ctx = await provider.runnerContext(run.runner_id);
		const meta = parseJson<ClaudeRunMeta>(run.provider_meta ?? null) ?? {};

		const session = await ctx.client.beta.sessions.retrieve(run.provider_session_id);
		const events = await ctx.client.beta.sessions.events.list(run.provider_session_id, {
			...(meta.events_cursor ? { 'created_at[gt]': meta.events_cursor } : {}),
			order: 'asc',
			limit: 200
		});

		const { lines, cursor, idleReason, lastError } = summarizeEvents(
			events.data,
			meta.events_cursor
		);

		const result: AdapterPollResult = {
			usage: mapUsage(session.usage),
			...(lines.length > 0 ? { logChunk: lines.join('\n') + '\n' } : {}),
			provider_meta: JSON.stringify({ ...meta, ...(cursor ? { events_cursor: cursor } : {}) })
		};

		if (session.status === 'terminated') {
			result.status = lastError ? 'failed' : 'completed';
			if (lastError) result.error = lastError;
		} else if (session.status === 'idle') {
			// A supervisor run is one launch prompt worked to completion: idle
			// means the turn ended. Abnormal pauses (the platform-enforced cost
			// cap, an unexpected tool ask) end the run too — the session is
			// archived so it cannot linger half-alive.
			const reason = idleReason ?? 'end_turn';
			if (reason === 'budget_reached') {
				result.status = 'failed';
				result.error = 'per-run cost cap reached (session paused at its platform budget)';
			} else if (reason === 'requires_action') {
				result.status = 'failed';
				result.error =
					'session paused awaiting a tool confirmation, which supervisor runs never grant';
			} else if (reason === 'retries_exhausted') {
				result.status = 'failed';
				result.error = lastError ?? 'session exhausted its retries';
			} else {
				result.status = 'completed';
			}
			// A clean end on a runner that can retain is NOT archived here:
			// whether the session lives on is a question about the issue's
			// end state, which only `finalizeEnd` (after the authoritative
			// `endRun`) can answer. Every other end archives immediately, as
			// it always has, and the ended-run GC is the crash backstop.
			const mayRetain =
				result.status === 'completed' &&
				ctx.row.resume_enabled === 1 &&
				isResumeProviderSupported(
					ctx.row.type as Runner['type'],
					ctx.config as Record<string, unknown>
				);
			if (!mayRetain) {
				await ctx.client.beta.sessions.archive(run.provider_session_id).catch(() => {});
			}
		}
		return result;
	}

	/**
	 * Called once the server has judged the end (see `RunnerAdapter`). A run
	 * that advanced its issue into an awaiting state on an opted-in runner
	 * keeps its session idle and its vault alive behind a `run_resource`;
	 * anything else disposes both here rather than waiting for the sweep.
	 */
	async function finalizeEnd(run: AdapterRunRef, input: AdapterEndInput): Promise<void> {
		if (!run.provider_session_id) return;
		const ctx = await provider.runnerContext(run.runner_id);
		const meta = parseJson<ClaudeRunMeta>(run.provider_meta ?? null) ?? {};
		const retain =
			input.outcome === 'advanced' &&
			input.ended_in_awaiting_state &&
			ctx.row.resume_enabled === 1 &&
			isResumeProviderSupported(
				ctx.row.type as Runner['type'],
				ctx.config as Record<string, unknown>
			) &&
			!!meta.vault_id &&
			!!meta.credential_id;
		if (!retain) {
			await ctx.client.beta.sessions.archive(run.provider_session_id).catch(() => {});
			if (meta.vault_id) {
				await ctx.client.beta.vaults.delete(meta.vault_id).catch(() => {});
			}
			await db
				.updateTable('agent_run')
				.set({ provider_meta: JSON.stringify({ ...meta, gc_done: true }) })
				.where('id', '=', run.id)
				.execute();
			return;
		}
		const expiresAt = input.now + ctx.row.resume_window_hours * 60 * 60 * 1000;
		await retainResumeResource(db, {
			id: newId('rres'),
			userId: input.user_id,
			runnerId: run.runner_id,
			issueId: input.issue_id,
			ownerRunId: run.id,
			kind: 'claude_managed',
			providerSessionId: run.provider_session_id,
			workspacePath: null,
			vaultId: meta.vault_id ?? null,
			credentialId: meta.credential_id ?? null,
			fingerprint: resumeFingerprint({
				runnerId: run.runner_id,
				harness: 'claude_managed',
				model: input.model,
				preambleVariant: 'claude_managed'
			}),
			expiresAt,
			now: input.now,
			// The event boundary the successor starts its log from: without it
			// the whole predecessor conversation replays into the new run.
			transferData: meta.events_cursor
				? JSON.stringify({ events_cursor: meta.events_cursor })
				: null
		});
		// The provider-side sweeps read this flag; the resource row is the
		// authority, but the flag is what stops a join in the hot GC loop.
		await db
			.updateTable('agent_run')
			.set({
				provider_meta: JSON.stringify({ ...meta, retained: true }),
				resume_expires_at: expiresAt
			})
			.where('id', '=', run.id)
			.execute();
	}

	async function cancel(run: AdapterRunRef): Promise<void> {
		if (!run.provider_session_id) return;
		const ctx = await provider.runnerContext(run.runner_id);
		// Interrupt stops the in-flight turn (ignored if the session is paused
		// at its budget); archive makes the session read-only either way.
		await ctx.client.beta.sessions.events
			.send(run.provider_session_id, { events: [{ type: 'user.interrupt' }] })
			.catch(() => {});
		await ctx.client.beta.sessions.archive(run.provider_session_id).catch(() => {});
	}

	async function sweepRunner(runner: { id: string; user_id: string }, now: number): Promise<void> {
		let ctx: RunnerContext;
		try {
			ctx = await provider.runnerContext(runner.id);
		} catch {
			return; // no key stored (or runner gone) — nothing provider-side to do
		}
		await disposeExpiredManagedResources(db, ctx.client, runner.id, now);
		await gcEndedRuns(db, ctx.client, runner.id);
		await reconcileVaults(db, ctx.client, runner.id);
		await reconcileSessions(db, ctx.client, runner.id, now);
	}

	return { launchMode: 'immediate', launch, poll, cancel, finalizeEnd, sweepRunner };
}
