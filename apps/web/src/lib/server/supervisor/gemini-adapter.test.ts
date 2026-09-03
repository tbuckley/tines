/**
 * Gemini adapter unit tests: the Gemini API, the CLI-bundle CDN, and our
 * own launch-materials endpoints are all served by one injected fake fetch,
 * so these exercise the real request shapes (background interaction with
 * agent_config, repository + inline sources, allowlist transforms carrying
 * the run key and the PAT, run-id labels) without any network.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../crypto';
import { createTestDb, type TestDb } from '../api/test-db';
import { resetCliBundleCache } from './cli-bundle';
import {
	checkInlineSources,
	createGeminiAdapter,
	githubBasicAuth,
	pingGeminiKey
} from './gemini-adapter';
import { addIssue, addRun, addRunner, NOW, seedBase, USER } from './test-fixtures';

const ENC_KEY = 'test-encryption-key';
const TINES_URL = 'https://tines.test';
const CLI_BUNDLE = '#!/usr/bin/env node\nconsole.log("tines");\n';

interface RecordedCall {
	method: string;
	host: string;
	path: string;
	body: unknown;
	headers: Record<string, string>;
}

/** Dispatching fake fetch for every host; routes are `${method} ${path}`. */
function fakeNetwork(overrides: Record<string, (call: RecordedCall) => unknown> = {}) {
	const calls: RecordedCall[] = [];
	let interactionCounter = 0;

	const defaults: Record<string, (call: RecordedCall) => unknown> = {
		// --- Gemini ---
		'GET /v1beta/models': () => ({ models: [] }),
		'POST /v1beta/interactions': () => ({
			id: `intr_${++interactionCounter}`,
			status: 'in_progress',
			environment_id: 'env_1'
		}),
		// --- the CLI bundle on the npm CDN ---
		'GET /npm/tines@latest/dist/tines.cjs': () =>
			new Response(CLI_BUNDLE, { status: 200, headers: { 'content-type': 'text/javascript' } }),
		// --- Tines launch materials ---
		'GET /api/v1/issues/iss_1': () => ({ id: 'iss_1', project_name: 'demo', number: 12 }),
		'GET /api/v1/issues/iss_1/prompt': () => ({ text: 'THE LAUNCH PROMPT' }),
		'GET /api/v1/issues/iss_1/context': () => ({
			prompt: { text: '', parts: [] },
			skills: [
				{
					item_id: 'ctx_s',
					name: 'review',
					scope: {},
					files: [{ path: 'SKILL.md', content: '# review\n' }],
					file_count: 1,
					version: 1
				}
			],
			repos: [
				{
					item_id: 'ctx_1',
					name: 'web',
					scope: {},
					url: 'https://github.com/o/web',
					branch: 'main',
					dir: 'web',
					version: 1
				}
			],
			overridden: [],
			conflicts: []
		})
	};

	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(
			typeof input === 'string' || input instanceof URL ? String(input) : input.url
		);
		const method = (init?.method ?? 'GET').toUpperCase();
		const rawHeaders = new Headers(init?.headers as HeadersInit | undefined);
		const headers: Record<string, string> = {};
		rawHeaders.forEach((v, k) => (headers[k.toLowerCase()] = v));
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
		const call: RecordedCall = { method, host: url.host, path: url.pathname, body, headers };
		calls.push(call);
		const handler = overrides[`${method} ${url.pathname}`] ?? defaults[`${method} ${url.pathname}`];
		if (!handler) {
			return new Response(
				JSON.stringify({ error: { message: `no fake for ${method} ${url.pathname}` } }),
				{ status: 500, headers: { 'content-type': 'application/json' } }
			);
		}
		const result = handler(call);
		if (result instanceof Response) return result;
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	}) as typeof globalThis.fetch;

	return {
		calls,
		fetch,
		of: (route: string) => calls.filter((c) => `${c.method} ${c.path}` === route)
	};
}

async function world(
	opts: {
		pat?: boolean;
		runnerConfig?: Record<string, unknown>;
		budget?: Record<string, number>;
	} = {}
) {
	const t = createTestDb();
	seedBase(t);
	t.env.SECRET_ENCRYPTION_KEY = ENC_KEY;
	t.env.BETTER_AUTH_URL = TINES_URL;
	const runnerId = addRunner(t, {
		id: 'rnr_g1',
		name: 'gemini',
		type: 'gemini_managed',
		config: opts.runnerConfig ?? { agent: 'antigravity-preview-05-2026' },
		secretEnc: await encryptSecret('AIza-live-key', ENC_KEY),
		budget: opts.budget ?? { max_run_cost_usd: 5 }
	});
	if (opts.pat !== false) {
		t.sqlite
			.prepare(
				`INSERT INTO supervisor_settings (user_id, enabled, quota, attempt_limit, github_pat_enc, github_pat_hint, updated_at)
				VALUES (?, 1, '{"type":"global_cap","limit":3}', 3, ?, 'github_p…wxyz', ${NOW})`
			)
			.run(USER, await encryptSecret('github_pat_test_token', ENC_KEY));
	}
	addIssue(t, { id: 'iss_1' });
	return { t, runnerId };
}

function launchInput(runnerId: string) {
	return {
		runId: 'arun_l1',
		issueId: 'iss_1',
		runner: {
			id: runnerId,
			type: 'gemini_managed',
			name: 'gemini',
			config: '{}',
			max_run_minutes: 30
		},
		tier: 'balanced' as const,
		model: 'gemini-3.8-flash',
		runKey: 'tines_runkey_secret'
	};
}

beforeEach(() => resetCliBundleCache());

describe('pingGeminiKey', () => {
	it('accepts a key the models endpoint accepts, and names a rejected one', async () => {
		const ok = fakeNetwork();
		expect(await pingGeminiKey('AIza-good', { fetch: ok.fetch })).toBeNull();
		expect(ok.calls[0].headers['x-goog-api-key']).toBe('AIza-good');

		const bad = fakeNetwork({
			'GET /v1beta/models': () =>
				new Response(
					JSON.stringify({
						error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' }
					}),
					{ status: 400, headers: { 'content-type': 'application/json' } }
				)
		});
		expect(await pingGeminiKey('AIza-bad', { fetch: bad.fetch })).toMatch(
			/rejected the API key \(400: API key not valid/
		);
	});
});

describe('githubBasicAuth / checkInlineSources', () => {
	it('encodes the PAT as GitHub basic auth with x-oauth-basic', () => {
		expect(githubBasicAuth('ghp_abc')).toBe(`Basic ${btoa('ghp_abc:x-oauth-basic')}`);
	});

	it('names the file over the per-file cap, and the total over the environment cap', () => {
		const big = 'x'.repeat(1024 * 1024 + 1);
		expect(() =>
			checkInlineSources([{ type: 'inline', target: '/workspace/skills/s/big.md', content: big }])
		).toThrow(/big\.md is 1048577 bytes/);
		const half = 'y'.repeat(700 * 1024);
		expect(() =>
			checkInlineSources([
				{ type: 'inline', target: '/workspace/a', content: half },
				{ type: 'inline', target: '/workspace/b', content: half },
				{ type: 'inline', target: '/workspace/c', content: half }
			])
		).toThrow(/detach a skill/);
	});
});

describe('gemini adapter launch', () => {
	let t: TestDb;
	let runnerId: string;

	beforeEach(async () => {
		({ t, runnerId } = await world());
	});

	it('creates one background interaction carrying the model, the sources, and the proxy transforms', async () => {
		const net = fakeNetwork();
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		const result = await adapter.launch(launchInput(runnerId));

		const [create] = net.of('POST /v1beta/interactions');
		expect(create.host).toBe('generativelanguage.googleapis.com');
		expect(create.headers['x-goog-api-key']).toBe('AIza-live-key');
		const body = create.body as Record<string, never>;
		expect(body).toMatchObject({
			agent: 'antigravity-preview-05-2026',
			agent_config: { type: 'antigravity', model: 'gemini-3.8-flash' },
			background: true,
			store: true,
			labels: { tines_run_id: 'arun_l1', tines_runner_id: runnerId }
		});
		// No token cap configured → no max_total_tokens.
		expect((body.agent_config as { max_total_tokens?: string }).max_total_tokens).toBeUndefined();

		// The prompt: preamble + launch prompt, never the run key.
		const input = body.input as string;
		expect(input).toContain('# Supervisor run');
		expect(input).toContain('demo/12');
		expect(input).toContain('THE LAUNCH PROMPT');
		expect(input).toContain('/workspace/bin/tines.cjs');
		expect(input).toContain('git checkout main');
		expect(input).toContain('/workspace/skills/review/');
		expect(input).not.toContain('tines_runkey_secret');
		expect(input).not.toContain('github_pat_test_token');

		// The environment: repo as a repository source at /workspace/<dir>, the
		// CLI build + wrapper + proxy-auth config and every skill file inline.
		const environment = body.environment as {
			type: string;
			sources: { type: string; source?: string; target: string; content?: string }[];
			network: { allowlist: { domain: string; transform?: Record<string, string> }[] };
		};
		expect(environment.type).toBe('remote');
		expect(environment.sources).toContainEqual({
			type: 'repository',
			source: 'https://github.com/o/web',
			target: '/workspace/web'
		});
		const byTarget = Object.fromEntries(environment.sources.map((s) => [s.target, s]));
		expect(byTarget['/workspace/bin/tines.cjs']).toMatchObject({
			type: 'inline',
			content: CLI_BUNDLE
		});
		expect(byTarget['/workspace/bin/tines'].content).toContain(
			'exec node /workspace/bin/tines.cjs'
		);
		expect(JSON.parse(byTarget['/workspace/bin/tines.config.json'].content as string)).toEqual({
			url: TINES_URL,
			auth: 'proxy'
		});
		expect(byTarget['/workspace/skills/review/SKILL.md']).toMatchObject({ content: '# review\n' });

		// The allowlist is the credential delivery: run key on the Tines host,
		// PAT on github.com (basic, for clones and pushes) and api.github.com.
		const transforms = Object.fromEntries(
			environment.network.allowlist.map((e) => [e.domain, e.transform ?? null])
		);
		expect(transforms['tines.test']).toEqual({ Authorization: 'Bearer tines_runkey_secret' });
		expect(transforms['github.com']).toEqual({
			Authorization: githubBasicAuth('github_pat_test_token')
		});
		expect(transforms['api.github.com']).toEqual({ Authorization: 'Bearer github_pat_test_token' });
		expect(transforms['registry.npmjs.org']).toBeNull();

		// Launch materials were fetched with the run key; the bundle from the CDN.
		expect(net.of('GET /api/v1/issues/iss_1/prompt')[0].headers['authorization']).toBe(
			'Bearer tines_runkey_secret'
		);
		expect(net.of('GET /npm/tines@latest/dist/tines.cjs')[0].host).toBe('cdn.jsdelivr.net');

		expect(result.provider_session_id).toBe('intr_1');
		expect(result.provider_url).toContain('aistudio.google.com');
		expect(JSON.parse(result.provider_meta ?? '{}')).toEqual({
			environment_id: 'env_1',
			steps_seen: 0
		});
	});

	it('maps max_run_tokens to agent_config.max_total_tokens', async () => {
		({ t, runnerId } = await world({ budget: { max_run_tokens: 250000 } }));
		const net = fakeNetwork();
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await adapter.launch(launchInput(runnerId));
		const [create] = net.of('POST /v1beta/interactions');
		expect((create.body as { agent_config: unknown }).agent_config).toEqual({
			type: 'antigravity',
			model: 'gemini-3.8-flash',
			max_total_tokens: '250000'
		});
	});

	it('reuses the fetched CLI bundle across launches', async () => {
		const net = fakeNetwork();
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await adapter.launch(launchInput(runnerId));
		await adapter.launch({ ...launchInput(runnerId), runId: 'arun_l2' });
		expect(net.of('GET /npm/tines@latest/dist/tines.cjs')).toHaveLength(1);
		expect(net.of('POST /v1beta/interactions')).toHaveLength(2);
	});

	it('fails the launch clearly when the CLI bundle is not published yet', async () => {
		const net = fakeNetwork({
			'GET /npm/tines@latest/dist/tines.cjs': () => new Response('Not found', { status: 404 })
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow(/returned 404/);
		expect(net.of('POST /v1beta/interactions')).toHaveLength(0);
	});

	it('honours TINES_CLI_BUNDLE_URL', async () => {
		t.env.TINES_CLI_BUNDLE_URL = 'https://mirror.test/tines.cjs';
		const net = fakeNetwork({ 'GET /tines.cjs': () => new Response(CLI_BUNDLE, { status: 200 }) });
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await adapter.launch(launchInput(runnerId));
		expect(net.of('GET /tines.cjs')[0].host).toBe('mirror.test');
	});

	it('fails the launch, clearly, when repos exist but no PAT is stored', async () => {
		({ t, runnerId } = await world({ pat: false }));
		const net = fakeNetwork();
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow(/GitHub PAT/);
		expect(net.of('POST /v1beta/interactions')).toHaveLength(0);
	});

	it('fails clearly on a non-GitHub repo URL', async () => {
		const net = fakeNetwork({
			'GET /api/v1/issues/iss_1/context': () => ({
				prompt: { text: '', parts: [] },
				skills: [],
				repos: [
					{
						item_id: 'ctx_1',
						name: 'internal',
						scope: {},
						url: 'https://git.corp.example/o/web',
						branch: null,
						dir: 'web',
						version: 1
					}
				],
				overridden: [],
				conflicts: []
			})
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow(
			/"internal".*not a github\.com repository/
		);
	});

	it('surfaces the provider error message (a bogus model override, e.g.) as the launch failure', async () => {
		const net = fakeNetwork({
			'POST /v1beta/interactions': () =>
				new Response(
					JSON.stringify({
						error: {
							code: 400,
							message: 'Model gemini-9 is not supported',
							status: 'INVALID_ARGUMENT'
						}
					}),
					{ status: 400, headers: { 'content-type': 'application/json' } }
				)
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch({ ...launchInput(runnerId), model: 'gemini-9' })).rejects.toThrow(
			/Model gemini-9 is not supported \(INVALID_ARGUMENT\)/
		);
	});
});

describe('gemini adapter poll', () => {
	async function polledWorld(interaction: Record<string, unknown>, stepsSeen = 0) {
		const { t, runnerId } = await world();
		addRun(t, {
			id: 'arun_p1',
			issueId: 'iss_1',
			runnerId,
			status: 'running',
			model: 'gemini-3.8-flash',
			providerSessionId: 'intr_p',
			providerMeta: JSON.stringify({ environment_id: 'env_1', steps_seen: stepsSeen }),
			startedAt: NOW
		});
		const net = fakeNetwork({
			'GET /v1beta/interactions/intr_p': () => ({ id: 'intr_p', ...interaction }),
			'POST /v1beta/interactions/intr_p/cancel': () => ({ id: 'intr_p', status: 'cancelled' })
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		return { t, net, adapter };
	}

	const runRef = (stepsSeen = 0) => ({
		id: 'arun_p1',
		runner_id: 'rnr_g1',
		provider_session_id: 'intr_p',
		provider_meta: JSON.stringify({ environment_id: 'env_1', steps_seen: stepsSeen }),
		model: 'gemini-3.8-flash'
	});

	it('prices usage from the table and renders only the steps past the cursor', async () => {
		const { adapter } = await polledWorld(
			{
				status: 'in_progress',
				usage: { total_input_tokens: 1_000_000, total_output_tokens: 100_000 },
				steps: [
					{ type: 'user_input', content: [{ type: 'text', text: 'go' }] },
					{ type: 'model_output', content: [{ type: 'text', text: 'Working on it' }] },
					{ type: 'function_call', id: 'c1', name: 'bash', arguments: { command: 'ls' } }
				]
			},
			1
		);
		const result = await adapter.poll!(runRef(1));
		expect(result.status).toBeUndefined();
		expect(result.usage).toEqual({
			input_tokens: 1_000_000,
			output_tokens: 100_000,
			cost_source: 'priced',
			cost_usd: 0.75 + 0.375
		});
		expect(result.logChunk).toBe('[agent] Working on it\n[tool] bash {"command":"ls"}\n');
		expect(JSON.parse(result.provider_meta ?? '{}')).toEqual({
			environment_id: 'env_1',
			steps_seen: 3
		});
	});

	it('ends the run when the interaction completes', async () => {
		const { adapter } = await polledWorld({ status: 'completed', usage: {}, steps: [] });
		const result = await adapter.poll!(runRef());
		expect(result.status).toBe('completed');
		expect(result.logChunk).toContain('[interaction] completed');
	});

	it('fails the run with the provider error when the interaction fails', async () => {
		const { adapter } = await polledWorld({
			status: 'failed',
			errors: [{ code: 'INTERNAL', message: 'provider exploded' }]
		});
		const result = await adapter.poll!(runRef());
		expect(result.status).toBe('failed');
		expect(result.error).toBe('provider exploded');
	});

	it('treats budget_exceeded as the per-run token cap tripping', async () => {
		const { adapter } = await polledWorld({ status: 'budget_exceeded' });
		const result = await adapter.poll!(runRef());
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/token cap/);
	});

	it('cancels an interaction stuck in requires_action and fails the run', async () => {
		const { net, adapter } = await polledWorld({ status: 'requires_action' });
		const result = await adapter.poll!(runRef());
		expect(result.status).toBe('failed');
		expect(net.of('POST /v1beta/interactions/intr_p/cancel')).toHaveLength(1);
	});
});

describe('gemini adapter cancel and sweepRunner', () => {
	it('cancels the interaction, tolerating an already-ended 404', async () => {
		const { t, runnerId } = await world();
		const net = fakeNetwork({
			'POST /v1beta/interactions/intr_c/cancel': () =>
				new Response(JSON.stringify({ error: { code: 404, message: 'not found' } }), {
					status: 404,
					headers: { 'content-type': 'application/json' }
				})
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await expect(
			adapter.cancel({ id: 'arun_c', runner_id: runnerId, provider_session_id: 'intr_c' })
		).resolves.toBeUndefined();
		expect(net.of('POST /v1beta/interactions/intr_c/cancel')).toHaveLength(1);
	});

	it('deletes ended runs’ environments exactly once', async () => {
		const { t, runnerId } = await world();
		addRun(t, {
			id: 'arun_done',
			issueId: 'iss_1',
			runnerId,
			status: 'completed',
			providerSessionId: 'intr_done',
			providerMeta: JSON.stringify({ environment_id: 'env_done', steps_seen: 4 }),
			startedAt: NOW
		});
		addRun(t, {
			id: 'arun_live',
			issueId: 'iss_1',
			runnerId,
			status: 'running',
			providerSessionId: 'intr_live',
			providerMeta: JSON.stringify({ environment_id: 'env_live', steps_seen: 0 }),
			startedAt: NOW
		});
		const net = fakeNetwork({
			'DELETE /v1beta/environments/env_done': () => new Response('{}', { status: 200 })
		});
		const adapter = createGeminiAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 1000);
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 2000);
		expect(net.of('DELETE /v1beta/environments/env_done')).toHaveLength(1);
		expect(net.of('DELETE /v1beta/environments/env_live')).toHaveLength(0);
		const meta = JSON.parse(
			(
				t.all('SELECT provider_meta FROM agent_run WHERE id = ?', 'arun_done')[0] as {
					provider_meta: string;
				}
			).provider_meta
		);
		expect(meta).toMatchObject({ environment_id: 'env_done', gc_done: true });
	});
});
