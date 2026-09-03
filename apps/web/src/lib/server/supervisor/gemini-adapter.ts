/**
 * The Gemini managed-runner adapter: background interactions against the
 * Interactions API's Antigravity agent (SPEC.md "Workspace setup and
 * launch", `gemini_managed`).
 *
 * Nothing is provisioned ahead of time: each launch is one `POST
 * /v1beta/interactions` with `background: true`, the tier-resolved model in
 * `agent_config`, and a fresh remote environment carrying the effective
 * repos as `repository` sources, every skill file and the single-file CLI
 * build as `inline` sources, and a network allowlist whose `transform`
 * entries inject the run key (Tines host) and the GitHub PAT (github.com,
 * api.github.com) at Google's egress proxy — neither secret ever enters the
 * sandbox. The per-run token cap maps to `agent_config.max_total_tokens`;
 * the dollar cap is enforced at poll time from table-priced usage.
 *
 * Spoken over `fetch`, not `@google/genai`: the SDK drags in Node-only
 * dependencies (google-auth-library, ws, protobufjs) for what is four REST
 * calls here, and an injected fetch is what the unit tests want anyway.
 *
 * Launch materials come from our own API with the run key, exactly as the
 * Claude adapter does (see managed-common.ts). Worker-bundled: no `$lib`.
 */
import {
	DEFAULT_GEMINI_AGENT,
	GEMINI_INLINE_SOURCE_MAX_BYTES,
	GEMINI_INLINE_SOURCES_TOTAL_MAX_BYTES,
	canonicalGitHubRepoUrl,
	type EffectiveContext,
	type IssueDetail,
	type LaunchPromptResponse,
	type RunnerBudget
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { decryptSecret } from '../crypto';
import { getDb, type Database } from '../db';
import type {
	AdapterLaunchInput,
	AdapterLaunchResult,
	AdapterPollResult,
	AdapterRunRef,
	RunnerAdapter
} from './adapter';
import { loadCliBundle } from './cli-bundle';
import {
	judgeInteraction,
	mapGeminiUsage,
	summarizeSteps,
	type GeminiInteraction
} from './gemini-steps';
import {
	createSelfApi,
	loadGithubPat,
	parseJson,
	requireEncryptionKey,
	tinesApiBaseUrl
} from './managed-common';
import {
	buildSupervisorPreamble,
	GEMINI_CLI_BUNDLE_PATH,
	GEMINI_CLI_CONFIG_PATH,
	GEMINI_CLI_WRAPPER_PATH,
	GEMINI_SKILLS_DIR
} from './preamble';

// ---------------------------------------------------------------------------
// Config shapes (runner.config / agent_run.provider_meta are adapter-owned)

/** `runner.config` for `gemini_managed`. */
export interface GeminiRunnerConfig {
	/** The managed agent to run interactions against; `DEFAULT_GEMINI_AGENT` when unset. */
	agent?: string;
}

/** `agent_run.provider_meta` for Gemini runs. */
export interface GeminiRunMeta {
	/** The per-run remote environment, deleted by the sweep once the run ends. */
	environment_id?: string;
	/** How many interaction steps have already been rendered to the log. */
	steps_seen?: number;
	/** Set once end-of-run provider resources were garbage-collected. */
	gc_done?: boolean;
}

export interface GeminiAdapterOptions {
	/** Injected in unit tests; reaches the Gemini API, the CDN, and self-API GETs. */
	fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// The Gemini API, over fetch

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Where Gemini interactions are inspected: AI Studio's logs page. */
export const GEMINI_CONSOLE_URL = 'https://aistudio.google.com/logs';

/**
 * Hosts a coding agent needs besides the repos and Tines itself — package
 * registries and GitHub's download hosts. The allowlist is closed by
 * construction, so anything not listed here is unreachable from the
 * sandbox; extend as agents report blocked installs.
 */
export const GEMINI_EGRESS_ALLOWLIST: readonly string[] = [
	'registry.npmjs.org',
	'registry.yarnpkg.com',
	'pypi.org',
	'files.pythonhosted.org',
	'crates.io',
	'static.crates.io',
	'index.crates.io',
	'proxy.golang.org',
	'sum.golang.org',
	'rubygems.org',
	'raw.githubusercontent.com',
	'objects.githubusercontent.com',
	'codeload.github.com'
];

export class GeminiApiError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'GeminiApiError';
	}
}

async function geminiRequest<T>(
	fetchFn: typeof globalThis.fetch,
	apiKey: string,
	method: 'GET' | 'POST' | 'DELETE',
	path: string,
	body?: unknown
): Promise<T> {
	const res = await fetchFn(`${GEMINI_API_BASE}${path}`, {
		method,
		headers: {
			'x-goog-api-key': apiKey,
			...(body !== undefined ? { 'content-type': 'application/json' } : {})
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {})
	});
	if (!res.ok) {
		let message = `Gemini API ${method} ${path} → ${res.status}`;
		try {
			const parsed = (await res.json()) as { error?: { message?: string; status?: string } };
			if (parsed.error?.message) {
				message = `${parsed.error.message}${parsed.error.status ? ` (${parsed.error.status})` : ''}`;
			}
		} catch {
			// Non-JSON error body; the status line stands.
		}
		throw new GeminiApiError(res.status, message);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Validates a pasted Gemini key with a cheap authenticated call before
 * anything is stored (USER_FLOWS.md flow 3). Returns null when the key
 * works; a human-readable failure otherwise.
 */
export async function pingGeminiKey(
	apiKey: string,
	opts: GeminiAdapterOptions = {}
): Promise<string | null> {
	const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
	try {
		await geminiRequest(fetchFn, apiKey, 'GET', '/models?pageSize=1');
		return null;
	} catch (e) {
		if (e instanceof GeminiApiError) {
			// An invalid key is a 400 (API_KEY_INVALID) on this API, not a 401.
			if (e.status === 400 || e.status === 401 || e.status === 403) {
				return `Gemini rejected the API key (${e.status}: ${e.message})`;
			}
			return `Gemini returned ${e.status} validating the key: ${e.message}`;
		}
		return `Could not reach the Gemini API: ${e instanceof Error ? e.message : String(e)}`;
	}
}

// ---------------------------------------------------------------------------
// Environment sources

interface InlineSource {
	type: 'inline';
	target: string;
	content: string;
}

interface RepositorySource {
	type: 'repository';
	source: string;
	target: string;
}

type Source = InlineSource | RepositorySource;

interface AllowlistEntry {
	domain: string;
	transform?: Record<string, string>;
}

const encoder = new TextEncoder();

/**
 * Checks the inline sources against the provider's caps up front, naming
 * the offender — the alternative is a provider 400 with no hint which of a
 * dozen skill files was the problem.
 */
export function checkInlineSources(sources: InlineSource[]): void {
	let total = 0;
	for (const source of sources) {
		const bytes = encoder.encode(source.content).length;
		if (bytes > GEMINI_INLINE_SOURCE_MAX_BYTES) {
			throw new Error(
				`${source.target} is ${bytes} bytes, over the ${GEMINI_INLINE_SOURCE_MAX_BYTES}-byte per-file cap Gemini environments enforce on inline sources`
			);
		}
		total += bytes;
	}
	if (total > GEMINI_INLINE_SOURCES_TOTAL_MAX_BYTES) {
		throw new Error(
			`the seeded files total ${total} bytes, over the ${GEMINI_INLINE_SOURCES_TOTAL_MAX_BYTES}-byte cap Gemini environments enforce on inline sources — detach a skill or two from this issue`
		);
	}
}

/**
 * GitHub's Basic form for git-over-HTTPS with a token: the token as the
 * username, `x-oauth-basic` as the password. Injected by the egress proxy
 * on every github.com request, which is what authenticates both the
 * environment's own clone of a private repo and the agent's pushes.
 */
export function githubBasicAuth(pat: string): string {
	return `Basic ${btoa(`${pat}:x-oauth-basic`)}`;
}

// ---------------------------------------------------------------------------
// Provider context: everything bound to one worker env

interface RunnerContext {
	row: Database['runner'];
	config: GeminiRunnerConfig;
	apiKey: string;
}

function createProviderContext(env: Env, opts: GeminiAdapterOptions) {
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
		return { row, config: parseJson<GeminiRunnerConfig>(row.config) ?? {}, apiKey };
	}

	const api = <T>(
		ctx: RunnerContext,
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown
	) => geminiRequest<T>(fetchFn, ctx.apiKey, method, path, body);

	return { db, fetchFn, runnerContext, api, apiGet: createSelfApi(env, opts.fetch) };
}

// ---------------------------------------------------------------------------
// Sweep housekeeping: delete the environments of ended runs

async function gcEndedRuns(
	db: Kysely<Database>,
	api: ReturnType<typeof createProviderContext>['api'],
	ctx: RunnerContext
): Promise<void> {
	// Environments idle out and are deleted after 7 days on their own; the
	// GC keeps a busy runner from holding dozens of dead sandboxes until
	// then. Interactions themselves stay — they are the console record.
	const ended = await db
		.selectFrom('agent_run')
		.select(['id', 'provider_meta'])
		.where('runner_id', '=', ctx.row.id)
		.where('status', 'not in', ['assigned', 'launching', 'running'])
		.where('provider_meta', 'is not', null)
		.orderBy('ended_at desc')
		.limit(25)
		.execute();
	for (const run of ended) {
		const meta = parseJson<GeminiRunMeta>(run.provider_meta);
		if (!meta || meta.gc_done) continue;
		try {
			if (meta.environment_id) {
				await api(ctx, 'DELETE', `/environments/${meta.environment_id}`).catch((e) => {
					if (!(e instanceof GeminiApiError && e.status === 404)) throw e;
				});
			}
			await db
				.updateTable('agent_run')
				.set({ provider_meta: JSON.stringify({ ...meta, gc_done: true }) })
				.where('id', '=', run.id)
				.execute();
		} catch (e) {
			console.error(`gemini sweep: GC for run ${run.id} failed:`, e);
		}
	}
}

// ---------------------------------------------------------------------------
// The adapter surface

export function createGeminiAdapter(env: Env, opts: GeminiAdapterOptions = {}): RunnerAdapter {
	const provider = createProviderContext(env, opts);
	const db = provider.db;

	async function launch(input: AdapterLaunchInput): Promise<AdapterLaunchResult> {
		const ctx = await provider.runnerContext(input.runner.id);
		const base = tinesApiBaseUrl(env);
		const apiHost = new URL(base).hostname;
		if (!input.model) throw new Error('Gemini launches need a resolved model for the tier');
		const agent = ctx.config.agent || DEFAULT_GEMINI_AGENT;

		// Launch materials, assembled at launch time over our own API.
		const [issue, prompt, context, cliBundle] = await Promise.all([
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
			),
			loadCliBundle(env, provider.fetchFn)
		]);
		const pat = await loadGithubPat(db, env, ctx.row.user_id);
		if (context.repos.length > 0 && !pat) {
			throw new Error(
				'No GitHub PAT is stored in supervisor settings, so this managed run cannot clone its repositories — add one on the Agents tab'
			);
		}
		// Repository sources take a GitHub URL; canonicalize the clone-tolerant
		// forms context items may carry, and name the item when it is not one.
		const repos = context.repos.map((repo) => {
			const canonical = canonicalGitHubRepoUrl(repo.url);
			if (!canonical) {
				throw new Error(
					`repo context item "${repo.name}" points at ${repo.url}, which is not a github.com repository URL; Gemini managed runs can only seed GitHub repos`
				);
			}
			return { ...repo, url: canonical };
		});

		const issueRef = `${issue.project_name}/${issue.number}`;
		const preamble = buildSupervisorPreamble({
			variant: 'gemini_managed',
			runId: input.runId,
			runnerName: ctx.row.name,
			issueRef,
			timeoutMinutes: input.runner.max_run_minutes,
			apiUrl: base,
			repoDirs: repos.map((r) => r.dir),
			repoBranches: Object.fromEntries(
				repos.filter((r) => r.branch).map((r) => [r.dir, r.branch as string])
			),
			skillNames: context.skills.map((s) => s.name)
		});

		// Inline sources: the CLI build, its wrapper and proxy-auth config, and
		// every skill file (SPEC.md: "the CLI ships into every workspace").
		const inline: InlineSource[] = [
			{ type: 'inline', target: GEMINI_CLI_BUNDLE_PATH, content: cliBundle },
			{
				type: 'inline',
				target: GEMINI_CLI_WRAPPER_PATH,
				content: `#!/bin/sh\nexec node ${GEMINI_CLI_BUNDLE_PATH} "$@"\n`
			},
			{
				type: 'inline',
				target: GEMINI_CLI_CONFIG_PATH,
				content: `${JSON.stringify({ url: base, auth: 'proxy' }, null, 2)}\n`
			},
			...context.skills.flatMap((skill) =>
				skill.files.map((file): InlineSource => ({
					type: 'inline',
					target: `${GEMINI_SKILLS_DIR}/${skill.name}/${file.path}`,
					content: file.content
				}))
			)
		];
		checkInlineSources(inline);
		const sources: Source[] = [
			...repos.map((repo): RepositorySource => ({
				type: 'repository',
				source: repo.url,
				target: `/workspace/${repo.dir}`
			})),
			...inline
		];

		// The allowlist is the credential delivery: the proxy substitutes these
		// headers at egress, so the sandbox never sees the run key or the PAT.
		const allowlist: AllowlistEntry[] = [
			{ domain: apiHost, transform: { Authorization: `Bearer ${input.runKey}` } },
			...(pat
				? [
						{ domain: 'github.com', transform: { Authorization: githubBasicAuth(pat) } },
						{ domain: 'api.github.com', transform: { Authorization: `Bearer ${pat}` } }
					]
				: [{ domain: 'github.com' }, { domain: 'api.github.com' }]),
			...GEMINI_EGRESS_ALLOWLIST.map((domain) => ({ domain }))
		];

		const budget = parseJson<RunnerBudget>(ctx.row.budget);
		const interaction = await provider.api<GeminiInteraction>(ctx, 'POST', '/interactions', {
			agent,
			agent_config: {
				type: 'antigravity',
				model: input.model,
				...(budget?.max_run_tokens !== undefined
					? { max_total_tokens: String(budget.max_run_tokens) }
					: {})
			},
			background: true,
			store: true,
			input: `${preamble}\n\n${prompt.text}`,
			environment: { type: 'remote', sources, network: { allowlist } },
			// The run-id tag is what reconciliation keys on. The API has no
			// interaction listing, so it is read back on the interaction itself.
			labels: { tines_run_id: input.runId, tines_runner_id: ctx.row.id }
		});

		const meta: GeminiRunMeta = {
			...(interaction.environment_id ? { environment_id: interaction.environment_id } : {}),
			steps_seen: 0
		};
		return {
			provider_session_id: interaction.id,
			provider_url: GEMINI_CONSOLE_URL,
			provider_meta: JSON.stringify(meta)
		};
	}

	// -------------------------------------------------------------------------
	// Polling: interaction status + usage + a rendered step summary for the log

	async function poll(run: AdapterRunRef): Promise<AdapterPollResult> {
		if (!run.provider_session_id) return {};
		const ctx = await provider.runnerContext(run.runner_id);
		const meta = parseJson<GeminiRunMeta>(run.provider_meta ?? null) ?? {};

		const interaction = await provider.api<GeminiInteraction>(
			ctx,
			'GET',
			`/interactions/${run.provider_session_id}`
		);
		const steps = interaction.steps ?? [];
		const { lines, lastError } = summarizeSteps(steps, meta.steps_seen ?? 0);
		const terminal = judgeInteraction(interaction, lastError);
		if (terminal) lines.push(`[interaction] ${interaction.status}`);

		const result: AdapterPollResult = {
			usage: mapGeminiUsage(interaction.usage, run.model ?? interaction.model ?? null),
			...(lines.length > 0 ? { logChunk: lines.join('\n') + '\n' } : {}),
			provider_meta: JSON.stringify({
				...meta,
				...(interaction.environment_id && !meta.environment_id
					? { environment_id: interaction.environment_id }
					: {}),
				steps_seen: steps.length
			})
		};
		if (terminal) {
			result.status = terminal.status;
			result.error = terminal.error;
			if (interaction.status === 'requires_action') {
				// Paused waiting for a tool result that will never come: stop it
				// so it cannot sit half-alive until its own timeout.
				await provider
					.api(ctx, 'POST', `/interactions/${run.provider_session_id}/cancel`)
					.catch(() => {});
			}
		}
		return result;
	}

	async function cancel(run: AdapterRunRef): Promise<void> {
		if (!run.provider_session_id) return;
		const ctx = await provider.runnerContext(run.runner_id);
		// 404 = already ended (cancel only applies to running background
		// interactions); either way the interaction is dead, which is the point.
		await provider
			.api(ctx, 'POST', `/interactions/${run.provider_session_id}/cancel`)
			.catch(() => {});
	}

	async function sweepRunner(runner: { id: string; user_id: string }): Promise<void> {
		let ctx: RunnerContext;
		try {
			ctx = await provider.runnerContext(runner.id);
		} catch {
			return; // no key stored (or runner gone) — nothing provider-side to do
		}
		await gcEndedRuns(db, provider.api, ctx);
	}

	return { launchMode: 'immediate', launch, poll, cancel, sweepRunner };
}
