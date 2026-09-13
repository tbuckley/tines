/**
 * Claude adapter unit tests: the Anthropic API and our own launch-materials
 * endpoints are both served by an injected fake fetch, so these exercise the
 * real request shapes (session budget in cents, vault credential scoping,
 * repo resources, run-id tagging) without any network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../crypto';
import { createTestDb, type TestDb } from '../api/test-db';
import { canonicalGitHubRepoUrl, createClaudeAdapter } from './claude-adapter';
import { resumeFingerprint } from './resume';
import { addIssue, addRun, addRunner, NOW, REVIEW, seedBase, USER } from './test-fixtures';

const ENC_KEY = 'test-encryption-key';
const TINES_URL = 'https://tines.test';

interface RecordedCall {
	method: string;
	path: string;
	body: unknown;
	headers: Record<string, string>;
}

/** Dispatching fake fetch for both hosts; routes are `${method} ${path}`. */
function fakeNetwork(overrides: Record<string, (call: RecordedCall) => unknown> = {}) {
	const calls: RecordedCall[] = [];
	let sessionCounter = 0;

	const defaults: Record<string, (call: RecordedCall) => unknown> = {
		// --- Anthropic ---
		'GET /v1/agents': () => ({ data: [], next_page: null }),
		'POST /v1/agents': () => ({ id: 'agent_1', version: 1 }),
		'POST /v1/environments': () => ({ id: 'env_1' }),
		'GET /v1/environments': () => ({ data: [], next_page: null }),
		'POST /v1/vaults': () => ({ id: 'vlt_1' }),
		'GET /v1/vaults': () => ({ data: [], next_page: null }),
		'POST /v1/vaults/vlt_1/credentials': () => ({ id: 'vcred_1' }),
		'DELETE /v1/vaults/vlt_1': () => ({ id: 'vlt_1', type: 'vault_deleted' }),
		'POST /v1/sessions': () => ({
			id: `sesn_${++sessionCounter}`,
			status: 'running',
			created_at: new Date(NOW).toISOString(),
			metadata: {},
			usage: {}
		}),
		'GET /v1/sessions': () => ({ data: [], next_page: null, prev_page: null }),
		// --- Tines launch materials ---
		'GET /api/v1/issues/iss_1': () => ({ id: 'iss_1', project_name: 'demo', number: 12 }),
		'GET /api/v1/issues/iss_1/prompt': () => ({ text: 'THE LAUNCH PROMPT' }),
		'GET /api/v1/issues/iss_1/context': () => ({
			prompt: { text: '', parts: [] },
			skills: [],
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
		const call: RecordedCall = { method, path: url.pathname, body, headers };
		calls.push(call);
		const handler =
			overrides[`${method} ${url.pathname}`] ??
			defaults[`${method} ${url.pathname}`] ??
			(method === 'GET' && url.pathname.startsWith('/v1/agents/')
				? () => ({ id: url.pathname.split('/').at(-1), version: 1 })
				: undefined);
		if (!handler) {
			// Unrouted mutations should fail tests loudly; unrouted GET/POST
			// housekeeping (events send, archive) succeeds with an empty object.
			if (url.pathname.endsWith('/archive') || url.pathname.endsWith('/events')) {
				return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return new Response(
				JSON.stringify({ error: { message: `no fake for ${method} ${url.pathname}` } }),
				{
					status: 500,
					headers: { 'content-type': 'application/json' }
				}
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
		id: 'rnr_c1',
		name: 'claude-cloud',
		type: 'claude_managed',
		config: opts.runnerConfig ?? {},
		secretEnc: await encryptSecret('sk-ant-live-key', ENC_KEY),
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
			type: 'claude_managed',
			name: 'claude-cloud',
			config: '{}',
			max_run_minutes: 30
		},
		tier: 'balanced' as const,
		model: 'claude-sonnet-5',
		runKey: 'tines_runkey_secret'
	};
}

describe('canonicalGitHubRepoUrl', () => {
	it('normalizes the clone-tolerant forms to https://github.com/{owner}/{repo}', () => {
		for (const url of [
			'https://github.com/o/web',
			'https://github.com/o/web.git',
			'https://github.com/o/web/',
			'http://github.com/o/web.git',
			'https://www.github.com/o/web',
			'git@github.com:o/web.git',
			'git@github.com:o/web',
			'ssh://git@github.com/o/web.git'
		]) {
			expect(canonicalGitHubRepoUrl(url), url).toBe('https://github.com/o/web');
		}
	});

	it('preserves dots in repo names without eating them as .git', () => {
		expect(canonicalGitHubRepoUrl('https://github.com/o/web.js')).toBe(
			'https://github.com/o/web.js'
		);
		expect(canonicalGitHubRepoUrl('https://github.com/o/web.js.git')).toBe(
			'https://github.com/o/web.js'
		);
	});

	it('rejects non-GitHub and non-repo URLs', () => {
		for (const url of [
			'https://gitlab.com/o/web',
			'https://github.com/o',
			'https://github.com/o/web/tree/main',
			'https://example.com/github.com/o/web',
			'not a url'
		]) {
			expect(canonicalGitHubRepoUrl(url), url).toBeNull();
		}
	});
});

describe('claude adapter launch', () => {
	let t: TestDb;
	let runnerId: string;

	beforeEach(async () => {
		({ t, runnerId } = await world());
	});

	it('provisions lazily, delivers the key via a per-run vault, and caps the session', async () => {
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		const result = await adapter.launch(launchInput(runnerId));

		// Environment: cloud, unrestricted egress.
		const [envCreate] = net.of('POST /v1/environments');
		expect(envCreate.body).toMatchObject({
			name: `tines-${runnerId}`,
			config: { type: 'cloud', networking: { type: 'unrestricted' } }
		});
		expect(envCreate.headers['x-api-key']).toBe('sk-ant-live-key');

		// Tier agent: minimal — default toolset, no directive system prompt.
		const [agentCreate] = net.of('POST /v1/agents');
		expect(agentCreate.body).toMatchObject({
			name: 'tines-claude-cloud-balanced-default',
			model: 'claude-sonnet-5',
			tools: [{ type: 'agent_toolset_20260401' }]
		});
		expect((agentCreate.body as { system?: string }).system).toBeUndefined();

		// The run key travels as a vault credential scoped to the Tines host,
		// header-substitution only — never in the prompt.
		const [credCreate] = net.of('POST /v1/vaults/vlt_1/credentials');
		expect(credCreate.body).toMatchObject({
			auth: {
				type: 'environment_variable',
				secret_name: 'TINES_API_KEY',
				secret_value: 'tines_runkey_secret',
				networking: { type: 'limited', allowed_hosts: ['tines.test'] },
				injection_location: { header: true }
			}
		});

		// The session: pinned agent, run-id tag, $5 cap in cents, repos as
		// github_repository resources carrying the decrypted PAT.
		const [sessionCreate] = net.of('POST /v1/sessions');
		const session = sessionCreate.body as Record<string, never>;
		expect(session).toMatchObject({
			agent: 'agent_1',
			environment_id: 'env_1',
			vault_ids: ['vlt_1'],
			metadata: { tines_run_id: 'arun_l1', tines_runner_id: runnerId },
			budget: { type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } },
			resources: [
				{
					type: 'github_repository',
					url: 'https://github.com/o/web',
					authorization_token: 'github_pat_test_token',
					mount_path: '/workspace/web',
					checkout: { type: 'branch', name: 'main' }
				}
			]
		});
		const events = session['initial_events'] as { type: string; content: { text: string }[] }[];
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('user.message');
		expect(events[0].content[0].text).toContain('# Supervisor run');
		expect(events[0].content[0].text).toContain('demo/12');
		expect(events[0].content[0].text).toContain('THE LAUNCH PROMPT');
		// The run key never appears in prompt text.
		expect(events[0].content[0].text).not.toContain('tines_runkey_secret');

		// Launch materials were fetched with the run key.
		const promptGet = net.of('GET /api/v1/issues/iss_1/prompt')[0];
		expect(promptGet.headers['authorization']).toBe('Bearer tines_runkey_secret');

		expect(result.provider_session_id).toBe('sesn_1');
		expect(result.provider_url).toContain('sesn_1');
		expect(JSON.parse(result.provider_meta ?? '{}')).toMatchObject({ vault_id: 'vlt_1' });

		// Provisioned ids are cached on the runner for the next launch.
		const config = JSON.parse(
			(t.all('SELECT config FROM runner WHERE id = ?', runnerId)[0] as { config: string }).config
		) as {
			environment_id: string;
			agents_by_signature: Record<string, { agent_id: string; model: string }>;
		};
		expect(config.environment_id).toBe('env_1');
		expect(Object.values(config.agents_by_signature)[0]).toMatchObject({
			agent_id: 'agent_1',
			model: 'claude-sonnet-5'
		});
		expect(t.all('SELECT resume_config_revision FROM runner WHERE id = ?', runnerId)).toEqual([
			{ resume_config_revision: 2 }
		]);
	});

	it('provisions a separate signature instead of mutating a drifted tier agent', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents: { balanced: { agent_id: 'agent_old', model: 'claude-sonnet-4-6' } }
			}
		}));
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.launch(launchInput(runnerId));

		expect(net.of('POST /v1/agents')).toHaveLength(1);
		expect(net.of('POST /v1/environments')).toHaveLength(0); // env cached
		expect(net.of('POST /v1/agents/agent_old')).toHaveLength(0);
		const config = JSON.parse(
			(t.all('SELECT config FROM runner WHERE id = ?', runnerId)[0] as { config: string }).config
		) as { agents_by_signature: Record<string, { model: string }> };
		expect(Object.values(config.agents_by_signature)[0]?.model).toBe('claude-sonnet-5');
		expect(t.all('SELECT resume_config_revision FROM runner WHERE id = ?', runnerId)).toEqual([
			{ resume_config_revision: 1 }
		]);
	});

	it('confirms an exact provider-returned effort before creating the session', async () => {
		const net = fakeNetwork({
			'POST /v1/agents': () => ({
				id: 'agent_effort',
				version: 1,
				model: { id: 'claude-sonnet-5', effort: { type: 'high' } }
			})
		});
		const recordEffortEvidence = vi.fn(async () => {});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.launch({
			...launchInput(runnerId),
			effort: 'high',
			recordEffortEvidence
		});

		expect(recordEffortEvidence).toHaveBeenCalledWith({
			status: 'confirmed',
			transport: 'managed_agent_config',
			attempted_effort: 'high',
			provider_agent_id: 'agent_effort',
			observed_model: 'claude-sonnet-5',
			observed_effort: 'high'
		});
		expect(net.of('POST /v1/sessions')).toHaveLength(1);
	});

	it('records and rejects a conflicting provider effort before session creation', async () => {
		const net = fakeNetwork({
			'POST /v1/agents': () => ({
				id: 'agent_effort',
				version: 1,
				model: { id: 'claude-sonnet-5', effort: 'medium' }
			})
		});
		const recordEffortEvidence = vi.fn(async () => {});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await expect(
			adapter.launch({
				...launchInput(runnerId),
				effort: 'high',
				recordEffortEvidence
			})
		).rejects.toThrow('provider returned');

		expect(recordEffortEvidence).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'rejected', observed_effort: 'medium' })
		);
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
	});

	it('retrieves and confirms a cached effort agent before reuse', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents_by_signature: {
					'["balanced","claude-sonnet-5","high"]': {
						agent_id: 'agent_cached',
						model: 'claude-sonnet-5',
						effort: 'high'
					}
				}
			}
		}));
		const net = fakeNetwork({
			'GET /v1/agents/agent_cached': () => ({
				id: 'agent_cached',
				model: { id: 'claude-sonnet-5', effort: { type: 'high' } }
			})
		});
		const recordEffortEvidence = vi.fn(async () => {});
		await createClaudeAdapter(t.env, { fetch: net.fetch }).launch({
			...launchInput(runnerId),
			effort: 'high',
			recordEffortEvidence
		});
		expect(net.of('POST /v1/agents')).toHaveLength(0);
		expect(recordEffortEvidence).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'confirmed', provider_agent_id: 'agent_cached' })
		);
	});

	it('replaces a cached effort agent that can no longer be retrieved', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents_by_signature: {
					'["balanced","claude-sonnet-5","high"]': {
						agent_id: 'agent_stale',
						model: 'claude-sonnet-5',
						effort: 'high'
					}
				}
			}
		}));
		const net = fakeNetwork({
			'GET /v1/agents/agent_stale': () => new Response('gone', { status: 404 }),
			'POST /v1/agents': () => ({
				id: 'agent_replacement',
				model: { id: 'claude-sonnet-5', effort: 'high' }
			})
		});
		await createClaudeAdapter(t.env, { fetch: net.fetch }).launch({
			...launchInput(runnerId),
			effort: 'high'
		});
		expect(net.of('POST /v1/agents')).toHaveLength(1);
		expect(net.of('POST /v1/sessions')[0]?.body).toMatchObject({ agent: 'agent_replacement' });
	});

	it('replaces a cached effort agent whose retrieved configuration is unverifiable', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents_by_signature: {
					'["balanced","claude-sonnet-5","high"]': {
						agent_id: 'agent_unverifiable',
						model: 'claude-sonnet-5',
						effort: 'high'
					}
				}
			}
		}));
		const net = fakeNetwork({
			'GET /v1/agents/agent_unverifiable': () => ({ id: 'agent_unverifiable' }),
			'POST /v1/agents': () => ({
				id: 'agent_replacement',
				model: { id: 'claude-sonnet-5', effort: 'high' }
			})
		});
		await createClaudeAdapter(t.env, { fetch: net.fetch }).launch({
			...launchInput(runnerId),
			effort: 'high'
		});
		expect(net.of('POST /v1/agents')).toHaveLength(1);
		expect(net.of('POST /v1/sessions')[0]?.body).toMatchObject({ agent: 'agent_replacement' });
	});

	it('rejects a cached effort agent whose retrieved configuration conflicts', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents_by_signature: {
					'["balanced","claude-sonnet-5","high"]': {
						agent_id: 'agent_conflict',
						model: 'claude-sonnet-5',
						effort: 'high'
					}
				}
			}
		}));
		const net = fakeNetwork({
			'GET /v1/agents/agent_conflict': () => ({
				id: 'agent_conflict',
				model: { id: 'claude-sonnet-5', effort: 'low' }
			})
		});
		await expect(
			createClaudeAdapter(t.env, { fetch: net.fetch }).launch({
				...launchInput(runnerId),
				effort: 'high'
			})
		).rejects.toThrow('cached provider agent configuration conflicts with intent');
		expect(net.of('POST /v1/agents')).toHaveLength(0);
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
	});

	it('does not treat a non-404 cached-agent retrieval failure as a cache miss', async () => {
		({ t, runnerId } = await world({
			runnerConfig: {
				environment_id: 'env_1',
				agents_by_signature: {
					'["balanced","claude-sonnet-5","high"]': {
						agent_id: 'agent_unavailable',
						model: 'claude-sonnet-5',
						effort: 'high'
					}
				}
			}
		}));
		const net = fakeNetwork({
			'GET /v1/agents/agent_unavailable': () => new Response('unavailable', { status: 503 })
		});
		await expect(
			createClaudeAdapter(t.env, { fetch: net.fetch }).launch({
				...launchInput(runnerId),
				effort: 'high'
			})
		).rejects.toThrow();
		expect(net.of('POST /v1/agents')).toHaveLength(0);
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
	});

	it('CAS-merges different signatures launched concurrently', async () => {
		({ t, runnerId } = await world({ runnerConfig: { environment_id: 'env_1' } }));
		let agent = 0;
		const net = fakeNetwork({
			'POST /v1/agents': (call) => ({
				id: `agent_${++agent}`,
				model: (call.body as { model: unknown }).model
			})
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await Promise.all([
			adapter.launch({ ...launchInput(runnerId), effort: 'low' }),
			adapter.launch({ ...launchInput(runnerId), effort: 'high' })
		]);
		const config = JSON.parse(
			(t.all('SELECT config FROM runner WHERE id = ?', runnerId)[0] as { config: string }).config
		) as { agents_by_signature: Record<string, unknown> };
		expect(Object.keys(config.agents_by_signature)).toEqual(
			expect.arrayContaining([
				'["balanced","claude-sonnet-5","low"]',
				'["balanced","claude-sonnet-5","high"]'
			])
		);
	});

	it('keeps same-signature concurrent misses bound to each created agent', async () => {
		({ t, runnerId } = await world({ runnerConfig: { environment_id: 'env_1' } }));
		let agent = 0;
		const net = fakeNetwork({
			'POST /v1/agents': (call) => ({
				id: `agent_${++agent}`,
				model: (call.body as { model: unknown }).model
			})
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await Promise.all([
			adapter.launch({ ...launchInput(runnerId), effort: 'high' }),
			adapter.launch({ ...launchInput(runnerId), effort: 'high' })
		]);
		expect(net.of('POST /v1/agents')).toHaveLength(2);
		expect(
			net.of('POST /v1/sessions').map((call) => (call.body as { agent: string }).agent)
		).toEqual(expect.arrayContaining(['agent_1', 'agent_2']));
		const config = JSON.parse(
			(t.all('SELECT config FROM runner WHERE id = ?', runnerId)[0] as { config: string }).config
		) as { agents_by_signature: Record<string, { agent_id: string }> };
		expect(config.agents_by_signature['["balanced","claude-sonnet-5","high"]']?.agent_id).toMatch(
			/^agent_[12]$/
		);
	});

	it('mounts a .git-suffixed context URL in canonical form', async () => {
		const net = fakeNetwork({
			'GET /api/v1/issues/iss_1/context': () => ({
				prompt: { text: '', parts: [] },
				skills: [],
				repos: [
					{
						item_id: 'ctx_1',
						name: 'web',
						scope: {},
						url: 'git@github.com:o/web.git',
						branch: null,
						dir: 'web',
						version: 1
					}
				],
				overridden: [],
				conflicts: []
			})
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.launch(launchInput(runnerId));
		const [sessionCreate] = net.of('POST /v1/sessions');
		expect((sessionCreate.body as { resources: { url: string }[] }).resources[0].url).toBe(
			'https://github.com/o/web'
		);
	});

	it('fails clearly on a non-GitHub repo URL instead of forwarding the provider 400', async () => {
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
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow(
			/"internal".*not a github\.com repository/
		);
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
	});

	it('fails the launch, clearly, when repos exist but no PAT is stored', async () => {
		({ t, runnerId } = await world({ pat: false }));
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow(/GitHub PAT/);
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
	});

	it('cleans up the per-run vault when session creation fails', async () => {
		const net = fakeNetwork({
			'POST /v1/sessions': () =>
				new Response(
					JSON.stringify({
						type: 'error',
						error: { type: 'invalid_request_error', message: 'boom' }
					}),
					{
						status: 400,
						headers: { 'content-type': 'application/json' }
					}
				)
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await expect(adapter.launch(launchInput(runnerId))).rejects.toThrow();
		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(1);
	});
});

describe('claude adapter poll', () => {
	async function polledWorld(session: Record<string, unknown>, events: unknown[] = []) {
		const { t, runnerId } = await world();
		const issueId = 'iss_1';
		addRun(t, {
			id: 'arun_p1',
			issueId,
			runnerId,
			status: 'running',
			providerSessionId: 'sesn_p',
			providerMeta: JSON.stringify({ vault_id: 'vlt_1' }),
			startedAt: NOW
		});
		const net = fakeNetwork({
			'GET /v1/sessions/sesn_p': () => session,
			'GET /v1/sessions/sesn_p/events': () => ({ data: events, next_page: null })
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		return { t, net, adapter };
	}

	const runRef = {
		id: 'arun_p1',
		runner_id: 'rnr_c1',
		provider_session_id: 'sesn_p',
		provider_meta: JSON.stringify({ vault_id: 'vlt_1' })
	};

	it('maps usage (cents → dollars, provider-reported) and renders the event summary', async () => {
		const { net, adapter } = await polledWorld(
			{
				id: 'sesn_p',
				status: 'running',
				usage: {
					input_tokens: 1200,
					output_tokens: 340,
					cache_read_input_tokens: 90,
					cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 2 },
					list_cost: { amount: '123', currency: 'USD' }
				}
			},
			[
				{
					type: 'agent.message',
					id: 'sevt_1',
					processed_at: '2026-08-27T10:00:00Z',
					content: [{ type: 'text', text: 'Working on it' }]
				},
				{
					type: 'agent.tool_use',
					id: 'sevt_2',
					processed_at: '2026-08-27T10:00:05Z',
					name: 'bash',
					input: { command: 'ls' }
				}
			]
		);
		const result = await adapter.poll!(runRef);
		expect(result.status).toBeUndefined();
		expect(result.usage).toEqual({
			input_tokens: 1200,
			output_tokens: 340,
			cache_read_tokens: 90,
			cache_write_tokens: 42,
			cost_usd: 1.23,
			cost_source: 'provider'
		});
		expect(result.logChunk).toContain('[agent] Working on it');
		expect(result.logChunk).toContain('[tool] bash');
		expect(JSON.parse(result.provider_meta ?? '{}')).toMatchObject({
			events_cursor: '2026-08-27T10:00:05Z',
			vault_id: 'vlt_1'
		});
		// The cursor is sent on the next poll's event list.
		const listCalls = net.of('GET /v1/sessions/sesn_p/events');
		expect(listCalls).toHaveLength(1);
	});

	it('treats idle end_turn as a completed run and archives the session', async () => {
		const { net, adapter } = await polledWorld({ id: 'sesn_p', status: 'idle', usage: {} }, [
			{
				type: 'session.status_idle',
				id: 'sevt_9',
				processed_at: '2026-08-27T10:01:00Z',
				stop_reason: { type: 'end_turn' }
			}
		]);
		const result = await adapter.poll!(runRef);
		expect(result.status).toBe('completed');
		expect(net.of('POST /v1/sessions/sesn_p/archive')).toHaveLength(1);
	});

	it('treats the platform budget pause as the per-run cap tripping', async () => {
		const { adapter } = await polledWorld({ id: 'sesn_p', status: 'idle', usage: {} }, [
			{
				type: 'session.status_idle',
				id: 'sevt_9',
				processed_at: '2026-08-27T10:01:00Z',
				stop_reason: { type: 'budget_reached' }
			}
		]);
		const result = await adapter.poll!(runRef);
		expect(result.status).toBe('failed');
		expect(result.error).toMatch(/cost cap/);
	});

	it('fails a terminated session that ended on an error', async () => {
		const { adapter } = await polledWorld({ id: 'sesn_p', status: 'terminated', usage: {} }, [
			{
				type: 'session.error',
				id: 'sevt_8',
				processed_at: '2026-08-27T10:00:30Z',
				error: { type: 'model_request_failed', message: 'provider exploded' }
			},
			{ type: 'session.status_terminated', id: 'sevt_9', processed_at: '2026-08-27T10:01:00Z' }
		]);
		const result = await adapter.poll!(runRef);
		expect(result.status).toBe('failed');
		expect(result.error).toBe('provider exploded');
	});
});

describe('claude adapter sweepRunner', () => {
	it('GCs ended runs (vault delete, session archive) exactly once, and cancels orphan sessions', async () => {
		const { t, runnerId } = await world();
		addRun(t, {
			id: 'arun_done',
			issueId: 'iss_1',
			runnerId,
			status: 'completed',
			providerSessionId: 'sesn_done',
			providerMeta: JSON.stringify({ vault_id: 'vlt_1' }),
			startedAt: NOW
		});
		t.sqlite.prepare('UPDATE agent_run SET ended_at = ? WHERE id = ?').run(NOW + 1000, 'arun_done');
		const net = fakeNetwork({
			'GET /v1/sessions': () => ({
				data: [
					{
						// Tagged with an unknown run id, past the stall grace: an orphan.
						id: 'sesn_orphan',
						status: 'running',
						created_at: new Date(NOW - 10 * 60_000).toISOString(),
						metadata: { tines_run_id: 'arun_unknown' }
					},
					{
						// Someone else's session: never touched.
						id: 'sesn_foreign',
						status: 'running',
						created_at: new Date(NOW - 10 * 60_000).toISOString(),
						metadata: {}
					}
				],
				next_page: null,
				prev_page: null
			})
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(1);
		expect(net.of('POST /v1/sessions/sesn_done/archive')).toHaveLength(1);
		expect(net.of('POST /v1/sessions/sesn_orphan/archive')).toHaveLength(1);
		expect(net.of('POST /v1/sessions/sesn_foreign/archive')).toHaveLength(0);
		const meta = JSON.parse(
			(
				t.all('SELECT provider_meta FROM agent_run WHERE id = ?', 'arun_done')[0] as {
					provider_meta: string;
				}
			).provider_meta
		) as { gc_done?: boolean };
		expect(meta.gc_done).toBe(true);

		// A second sweep is a no-op for the GC'd run.
		const net2 = fakeNetwork();
		const adapter2 = createClaudeAdapter(t.env, { fetch: net2.fetch });
		await adapter2.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 120_000);
		expect(net2.of('DELETE /v1/vaults/vlt_1')).toHaveLength(0);
	});

	it('the vault-name fallback deletes vaults whose run never recorded them, sparing active and foreign ones', async () => {
		const { t, runnerId } = await world();
		addRun(t, {
			id: 'arun_live',
			issueId: 'iss_1',
			runnerId,
			status: 'running',
			providerSessionId: 'sesn_x'
		});
		addRun(t, { id: 'arun_dead', issueId: 'iss_1', runnerId, status: 'canceled' });
		const deleted: string[] = [];
		const net = fakeNetwork({
			'GET /v1/vaults': () => ({
				data: [
					{ id: 'vlt_live', display_name: 'tines-run-arun_live' },
					{ id: 'vlt_dead', display_name: 'tines-run-arun_dead' },
					{ id: 'vlt_gone', display_name: 'tines-run-arun_never_existed' },
					{ id: 'vlt_theirs', display_name: 'someone-elses-vault' }
				],
				next_page: null
			}),
			'DELETE /v1/vaults/vlt_dead': (c) => (deleted.push(c.path), { id: 'vlt_dead' }),
			'DELETE /v1/vaults/vlt_gone': (c) => (deleted.push(c.path), { id: 'vlt_gone' })
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);
		expect(deleted.sort()).toEqual(['/v1/vaults/vlt_dead', '/v1/vaults/vlt_gone']);
		expect(net.of('DELETE /v1/vaults/vlt_live')).toHaveLength(0);
		expect(net.of('DELETE /v1/vaults/vlt_theirs')).toHaveLength(0);
	});
});

describe('claude adapter resume ownership', () => {
	/** A retained managed resource: the row that holds a session past its run. */
	function retain(
		t: TestDb,
		runnerId: string,
		opts: {
			state?: string;
			expiresAt?: number;
			claimStartedAt?: number | null;
			transferPhase?: string | null;
		} = {}
	) {
		t.sqlite
			.prepare(
				`INSERT INTO run_resource (id, user_id, runner_id, issue_id, kind, owner_run_id, state,
					claim_run_id, claim_token, claim_started_at, transfer_phase, expires_at,
					available_seen_at, provider_session_id, vault_id, credential_id, workspace_path,
					resume_fingerprint, transfer_data, created_at, updated_at)
				VALUES (?, ?, ?, 'iss_1', 'claude_managed', 'arun_kept', ?, ?, ?, ?, ?, ?, ?,
					'sesn_kept', 'vlt_1', 'vcred_1', NULL, 'fp', NULL, ?, ?)`
			)
			.run(
				'rres_1',
				USER,
				runnerId,
				opts.state ?? 'available',
				null,
				opts.state === 'claimed' ? 'tok' : null,
				opts.claimStartedAt ?? null,
				opts.transferPhase ?? null,
				opts.expiresAt ?? NOW + 60 * 60 * 1000,
				NOW,
				NOW,
				NOW
			);
	}

	async function retainedWorld() {
		const { t, runnerId } = await world();
		addRun(t, {
			id: 'arun_kept',
			issueId: 'iss_1',
			runnerId,
			status: 'completed',
			providerSessionId: 'sesn_kept',
			providerMeta: JSON.stringify({ vault_id: 'vlt_1', credential_id: 'vcred_1', retained: true }),
			startedAt: NOW
		});
		t.sqlite.prepare('UPDATE agent_run SET ended_at = ? WHERE id = ?').run(NOW + 1000, 'arun_kept');
		return { t, runnerId };
	}

	function sweepNetwork() {
		return fakeNetwork({
			// The retained run's own vault, findable by name — which is how the
			// vault sweep would otherwise reach it.
			'GET /v1/vaults': () => ({
				data: [{ id: 'vlt_1', display_name: 'tines-run-arun_kept' }],
				next_page: null
			}),
			'GET /v1/sessions': () => ({
				data: [
					{
						id: 'sesn_kept',
						status: 'idle',
						created_at: new Date(NOW - 10 * 60_000).toISOString(),
						metadata: { tines_run_id: 'arun_kept' }
					}
				],
				next_page: null,
				prev_page: null
			})
		});
	}

	it('spares a retained session AND its vault — the credential must survive for the transfer', async () => {
		const { t, runnerId } = await retainedWorld();
		retain(t, runnerId);
		const net = sweepNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		// All three sweeps must respect the resource: the run HAS ended, which
		// is exactly what they would otherwise read as garbage.
		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(0);
		expect(net.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(0);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(1);
	});

	it('disposes the session and vault once the window has closed', async () => {
		const { t, runnerId } = await retainedWorld();
		retain(t, runnerId, { expiresAt: NOW + 1000 });
		const net = sweepNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		// Disposal archives it; the ordinary GC then finds an ended run whose
		// session is no longer retained and archives again — both are correct.
		expect(net.of('POST /v1/sessions/sesn_kept/archive').length).toBeGreaterThanOrEqual(1);
		expect(net.of('DELETE /v1/vaults/vlt_1').length).toBeGreaterThanOrEqual(1);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(0);
	});

	it('disposes a claim whose transfer died, so a failed launch cannot pin a session forever', async () => {
		const { t, runnerId } = await retainedWorld();
		// Claimed by a launch that threw mid-transfer: unexpired, so only the
		// stale-claim arm can reach it — and nothing else ever will.
		retain(t, runnerId, {
			state: 'claimed',
			transferPhase: 'sending',
			claimStartedAt: NOW - 60 * 60 * 1000,
			expiresAt: NOW + 60 * 60 * 1000
		});
		const net = sweepNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		expect(net.of('POST /v1/sessions/sesn_kept/archive').length).toBeGreaterThanOrEqual(1);
		expect(net.of('DELETE /v1/vaults/vlt_1').length).toBeGreaterThanOrEqual(1);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(0);
	});

	it('leaves a completed hand-over alone: `accepted` means the successor owns the session', async () => {
		const { t, runnerId } = await retainedWorld();
		retain(t, runnerId, {
			state: 'claimed',
			transferPhase: 'accepted',
			claimStartedAt: NOW - 60 * 60 * 1000
		});
		const net = sweepNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		expect(net.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(0);
		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(0);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(1);
	});
});

describe('claude adapter resume launch (the hand-over)', () => {
	/**
	 * A runner + predecessor + resource shaped so `prepareManagedResume`
	 * says yes: the predecessor is the newest ended run, it advanced its
	 * issue into an awaiting state, and the resource is `available` with the
	 * fingerprint this launch computes.
	 */
	// `prepareManagedResume` is called by the real `launch`, which stamps
	// `Date.now()` — so the window has to be live on the wall clock, not on
	// the fixtures' frozen NOW.
	const REAL_NOW = Date.now();

	async function handoverWorld() {
		const { t, runnerId } = await world({ runnerConfig: { environment_id: 'env_1' } });
		t.sqlite.prepare('UPDATE runner SET resume_enabled = 1 WHERE id = ?').run(runnerId);
		// The run being launched, and the one it would continue.
		addRun(t, { id: 'arun_l1', issueId: 'iss_1', runnerId, status: 'assigned' });
		addRun(t, {
			id: 'arun_kept',
			issueId: 'iss_1',
			runnerId,
			status: 'completed',
			providerSessionId: 'sesn_kept',
			providerMeta: JSON.stringify({ vault_id: 'vlt_1', credential_id: 'vcred_1', retained: true }),
			startedAt: NOW,
			endedAt: REAL_NOW - 60_000,
			stateAtEnd: REVIEW,
			outcome: 'advanced',
			usage: JSON.stringify({
				input_tokens: 1000,
				output_tokens: 500,
				cache_read_tokens: 0,
				cache_write_tokens: 0,
				cost_usd: 0.25
			})
		});
		t.sqlite
			.prepare(
				`INSERT INTO run_resource (id, user_id, runner_id, issue_id, kind, owner_run_id, state,
					expires_at, available_seen_at, provider_session_id, vault_id, credential_id,
					resume_fingerprint, transfer_data, created_at, updated_at)
				VALUES ('rres_h', ?, ?, 'iss_1', 'claude_managed', 'arun_kept', 'available', ?, ?,
					'sesn_kept', 'vlt_1', 'vcred_1', ?, ?, ?, ?)`
			)
			.run(
				USER,
				runnerId,
				REAL_NOW + 47 * 60 * 60 * 1000,
				NOW,
				resumeFingerprint({
					runnerId,
					harness: 'claude_managed',
					model: 'claude-sonnet-5',
					preambleVariant: 'claude_managed'
				}),
				JSON.stringify({ events_cursor: '2024-01-01T00:00:00Z' }),
				NOW,
				NOW
			);
		return { t, runnerId };
	}

	function handoverNetwork(overrides: Record<string, (call: never) => unknown> = {}) {
		return fakeNetwork({
			'POST /v1/vaults/vlt_1/credentials/vcred_1': () => ({ id: 'vcred_1' }),
			'POST /v1/sessions/sesn_kept': () => ({
				id: 'sesn_kept',
				status: 'idle',
				created_at: new Date(NOW).toISOString(),
				metadata: {},
				usage: {}
			}),
			...(overrides as Record<string, (call: RecordedCall) => unknown>)
		});
	}

	it('continues the retained session instead of creating one: rotate, retag, send', async () => {
		const { t, runnerId } = await handoverWorld();
		const net = handoverNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		const result = await adapter.launch(launchInput(runnerId));

		expect(result.provider_session_id).toBe('sesn_kept');
		// No new session, vault or environment: the whole point of the resume.
		expect(net.of('POST /v1/sessions')).toHaveLength(0);
		expect(net.of('POST /v1/vaults')).toHaveLength(0);
		// The credential the session reads TINES_API_KEY from now holds the new
		// run's key, and the rotation precedes the send.
		const rotate = net.of('POST /v1/vaults/vlt_1/credentials/vcred_1')[0]!;
		expect(rotate.body).toMatchObject({
			auth: { type: 'environment_variable', secret_value: 'tines_runkey_secret' }
		});
		const retag = net.of('POST /v1/sessions/sesn_kept')[0]!;
		expect(retag.body).toMatchObject({ metadata: { tines_run_id: 'arun_l1' } });
		const send = net.of('POST /v1/sessions/sesn_kept/events')[0]!;
		expect(net.calls.indexOf(rotate)).toBeLessThan(net.calls.indexOf(send));
		const events = (send.body as { events: Array<{ type: string }> }).events;
		expect(events[0]!.type).toBe('user.message');

		expect(
			t.all(
				'SELECT resumed_from_run_id, resume_fallback_reason FROM agent_run WHERE id = ?',
				'arun_l1'
			)
		).toEqual([{ resumed_from_run_id: 'arun_kept', resume_fallback_reason: null }]);
		// The completed hand-over drops the resource: ownership now lives on
		// the successor's provider_meta, and the predecessor stops claiming
		// the handles so its end-of-run GC cannot collect them.
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(0);
		expect(
			JSON.parse(
				t.all('SELECT provider_meta FROM agent_run WHERE id = ?', 'arun_kept')[0]!
					.provider_meta as string
			)
		).toMatchObject({ retained: false, gc_done: true });
		expect(JSON.parse(result.provider_meta!)).toMatchObject({
			vault_id: 'vlt_1',
			credential_id: 'vcred_1',
			events_cursor: '2024-01-01T00:00:00Z'
		});
	});

	it('the next sweep leaves the successor alone: the predecessor stops owning the handles', async () => {
		const { t, runnerId } = await handoverWorld();
		const net = handoverNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		const result = await adapter.launch(launchInput(runnerId));
		// The run the launch belongs to is now live in the inherited session.
		t.sqlite
			.prepare(
				'UPDATE agent_run SET status = ?, provider_session_id = ?, provider_meta = ? WHERE id = ?'
			)
			.run('running', result.provider_session_id!, result.provider_meta ?? null, 'arun_l1');

		const sweepNet = fakeNetwork({
			// The vault is still named after the PREDECESSOR — the transfer
			// retags the session, never the vault — and that run has ended.
			'GET /v1/vaults': () => ({
				data: [{ id: 'vlt_1', display_name: 'tines-run-arun_kept' }],
				next_page: null
			}),
			'GET /v1/sessions': () => ({
				data: [
					{
						id: 'sesn_kept',
						status: 'running',
						created_at: new Date(NOW - 10 * 60_000).toISOString(),
						metadata: { tines_run_id: 'arun_l1' }
					}
				],
				next_page: null,
				prev_page: null
			})
		});
		const sweeper = createClaudeAdapter(t.env, { fetch: sweepNet.fetch });
		await sweeper.sweepRunner!({ id: runnerId, user_id: USER }, NOW + 60_000);

		// Nothing may be collected: the credential this run reads its key from
		// and the session it is talking in are both live.
		expect(sweepNet.of('DELETE /v1/vaults/vlt_1')).toHaveLength(0);
		expect(sweepNet.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(0);
	});

	it('a provider error before the send launches fresh instead of failing the run', async () => {
		const { t, runnerId } = await handoverWorld();
		const net = handoverNetwork({
			'POST /v1/vaults/vlt_1/credentials/vcred_1': () =>
				new Response(JSON.stringify({ error: { message: 'boom' } }), {
					status: 500,
					headers: { 'content-type': 'application/json' }
				})
		});
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		const result = await adapter.launch(launchInput(runnerId));

		// Fresh launch: a new session on a new vault, and nothing sent to the
		// retained one.
		expect(result.provider_session_id).not.toBe('sesn_kept');
		expect(net.of('POST /v1/sessions')).toHaveLength(1);
		expect(net.of('POST /v1/vaults')).toHaveLength(1);
		expect(net.of('POST /v1/sessions/sesn_kept/events')).toHaveLength(0);
		expect(
			t.all(
				'SELECT resumed_from_run_id, resume_fallback_reason FROM agent_run WHERE id = ?',
				'arun_l1'
			)
		).toEqual([{ resumed_from_run_id: null, resume_fallback_reason: 'unavailable' }]);
		// The abandoned claim is left for the disposal sweep, not pinned.
		expect(t.all('SELECT state FROM run_resource')).toEqual([{ state: 'disposing' }]);
	});
});

describe('claude adapter finalizeEnd (retain or archive)', () => {
	const runRef = {
		id: 'arun_kept',
		runner_id: 'rnr_c1',
		provider_session_id: 'sesn_kept',
		provider_meta: JSON.stringify({
			vault_id: 'vlt_1',
			credential_id: 'vcred_1',
			events_cursor: '2024-01-01T00:00:00Z'
		})
	};
	const endInput = {
		user_id: USER,
		issue_id: 'iss_1',
		model: 'claude-sonnet-5',
		outcome: 'advanced',
		ended_in_awaiting_state: true,
		now: NOW
	};

	async function endedWorld(opts: { resume?: boolean } = {}) {
		const { t, runnerId } = await world();
		if (opts.resume !== false)
			t.sqlite.prepare('UPDATE runner SET resume_enabled = 1 WHERE id = ?').run(runnerId);
		addRun(t, {
			id: 'arun_kept',
			issueId: 'iss_1',
			runnerId,
			status: 'completed',
			providerSessionId: 'sesn_kept',
			providerMeta: runRef.provider_meta,
			startedAt: NOW,
			endedAt: NOW + 1000
		});
		return { t, runnerId };
	}

	it('a run that advanced its issue into an awaiting state keeps its session and vault', async () => {
		const { t } = await endedWorld();
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.finalizeEnd!(runRef, endInput);

		expect(net.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(0);
		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(0);
		const [resource] = t.all('SELECT * FROM run_resource');
		expect(resource).toMatchObject({
			kind: 'claude_managed',
			state: 'available',
			owner_run_id: 'arun_kept',
			provider_session_id: 'sesn_kept',
			vault_id: 'vlt_1',
			credential_id: 'vcred_1',
			// The successor's log boundary: without it the predecessor's whole
			// conversation replays into the new run.
			transfer_data: JSON.stringify({ events_cursor: '2024-01-01T00:00:00Z' }),
			expires_at: NOW + 48 * 60 * 60 * 1000
		});
		expect(
			JSON.parse(
				t.all('SELECT provider_meta FROM agent_run WHERE id = ?', 'arun_kept')[0]!
					.provider_meta as string
			)
		).toMatchObject({ retained: true });
	});

	it.each([
		['the run did not advance the issue', { outcome: 'stalled' }],
		['the issue did not land in an awaiting state', { ended_in_awaiting_state: false }]
	])('archives immediately when %s', async (_label, override) => {
		const { t } = await endedWorld();
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.finalizeEnd!(runRef, { ...endInput, ...override });

		expect(net.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(1);
		expect(net.of('DELETE /v1/vaults/vlt_1')).toHaveLength(1);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(0);
	});

	it('archives immediately when the runner is not opted in', async () => {
		const { t } = await endedWorld({ resume: false });
		const net = fakeNetwork();
		const adapter = createClaudeAdapter(t.env, { fetch: net.fetch });
		await adapter.finalizeEnd!(runRef, endInput);

		expect(net.of('POST /v1/sessions/sesn_kept/archive')).toHaveLength(1);
		expect(t.all('SELECT id FROM run_resource')).toHaveLength(0);
	});
});
