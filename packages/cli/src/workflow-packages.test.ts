import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ApiError,
	ApiNetworkError,
	canonicalizeLibraryValue,
	withLibraryDocumentDigest,
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { inheritedPackage } from '../../shared/src/library/fixtures.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';
import {
	assertPlanBinding,
	expectedWorkflowPackageOperations,
	formatWorkflowPackageReview,
	recoverOrInstall
} from './workflow-packages.js';

let server: Server;
let baseUrl: string;
let document: WorkflowPackageDocument;
let plan: PrepareWorkflowPackageResponse;
let requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
const dir = mkdtempSync(join(tmpdir(), 'tines-workflow-cli-'));
const packagePath = join(dir, 'workflow.json');
const planPath = join(dir, 'plan.json');

function response(value: unknown, status = 200) {
	return { status, body: JSON.stringify(value), headers: { 'content-type': 'application/json' } };
}

beforeAll(async () => {
	document = await withLibraryDocumentDigest(inheritedPackage());
	writeFileSync(packagePath, JSON.stringify(document));
	plan = {
		operations: [],
		document,
		resolved: {
			choices: {},
			names: { 'workflow:1': 'Main' },
			inputs: [
				{
					input_id: 'input:1',
					type: 'label',
					mode: 'create',
					value: 'qa',
					id: 'allocated_label',
					color: 'blue'
				}
			],
			labels: [],
			workflows: document.workflows,
			context: document.context,
			schedules: [],
			routing: [],
			patches: [
				{
					record_id: 'workflow:1',
					field: 'description',
					original: 'Review {{filing_label:qa}} work',
					rendered: 'Review qa work',
					uses: [{ id: 'use:1', input_id: 'input:1', count: 1 }]
				}
			],
			skipped: []
		},
		allocation: {
			records: Object.fromEntries(
				[
					...document.workflows.flatMap((workflow) => [
						workflow.id,
						...workflow.states.map((state) => state.id),
						...workflow.transitions.map((transition) => transition.id)
					]),
					...document.context.flatMap((item) => [
						item.id,
						...(item.kind === 'skill' ? item.files.map((file) => file.id) : [])
					])
				].map((id, index) => [id, { id: `allocated_${index}`, event_id: null }])
			),
			labels: { 'input:1': { id: 'allocated_label', event_id: null } }
		},
		plan_id: 'plan_1',
		plan_digest: 'sha256:' + 'b'.repeat(64),
		document_digest: document.digest,
		issued_at: Date.now(),
		expires_at: Date.now() + 60_000,
		actor_key: 'key_1',
		compiler_version: 1,
		plan_token: 'signed-secret-plan-token',
		budget: { statements: 12, max_parameters: 4, max_sql_bytes: 100, max_value_bytes: 20 }
	};
	plan.operations = expectedWorkflowPackageOperations(plan) as typeof plan.operations;
	const unsigned = {
		version: 1,
		compiler_version: plan.compiler_version,
		id: plan.plan_id,
		user_id: 'user_1',
		actor_key: plan.actor_key,
		issued_at: plan.issued_at,
		expires_at: plan.expires_at,
		document_digest: plan.document_digest,
		choices: plan.resolved.choices,
		allocation: plan.allocation,
		selection: {
			workflow_ids: [],
			workflow_names: [],
			project_ids: [],
			label_ids: [],
			label_names: [],
			schedules: [],
			routing_scopes: [],
			runner_ids: []
		},
		witness_hash: '0'.repeat(64),
		budget: plan.budget
	};
	plan.plan_digest = `sha256:${createHash('sha256')
		.update(canonicalizeLibraryValue({ plan: unsigned, resolved: plan.resolved }))
		.digest('hex')}`;
	const payload = { ...unsigned, plan_digest: plan.plan_digest };
	plan.plan_token = `wip1.${Buffer.from(canonicalizeLibraryValue(payload)).toString('base64url')}.${Buffer.alloc(32).toString('base64url')}`;
	server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const raw = Buffer.concat(chunks).toString();
		const body = raw ? JSON.parse(raw) : null;
		const url = new URL(req.url ?? '/', 'http://local');
		requests.push({ method: req.method ?? '', path: url.pathname + url.search, body });
		let result;
		if (url.pathname === '/api/v1/workflows') {
			result = response({
				items: [
					{ id: 'wf_source', name: 'Source', states: [], transitions: [] },
					{ id: 'wf_other', name: 'Source', states: [], transitions: [] }
				],
				next_cursor: null
			});
		} else if (url.pathname === '/api/v1/workflows/wf_source/export') result = response(document);
		else if (url.pathname === '/api/v1/library/validate') {
			const valid = !(body.document_json as string).includes('not-json');
			result = response({
				valid,
				digest: valid ? document.digest : null,
				document: valid ? document : undefined,
				diagnostics: valid ? [] : [{ path: '', code: 'invalid_json', message: 'bad JSON' }],
				limits: { max_document_bytes: 5242880, max_records: 1000, max_depth: 64 }
			});
		} else if (url.pathname === '/api/v1/library/prepare') result = response(plan);
		else if (url.pathname === '/api/v1/library/installs/plan_1')
			result = response({ error: { code: 'not_found', message: 'missing' } }, 404);
		else if (
			url.pathname === '/api/v1/library/install' &&
			req.headers.authorization === 'Bearer tines_run_key'
		)
			result = response(
				{ error: { code: 'run_key_forbidden', message: 'run keys cannot install packages' } },
				403
			);
		else if (url.pathname === '/api/v1/library/install')
			result = response({
				id: 'plan_1',
				document_digest: document.digest,
				plan_digest: plan.plan_digest,
				committed_at: Date.now(),
				objects: [],
				reused_inputs: []
			});
		else result = response({ error: { code: 'not_found', message: 'missing' } }, 404);
		res.writeHead(result.status, result.headers);
		res.end(result.body);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
	requests = [];
});

function cli(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'tines_named_key' } },
			(error, stdout, stderr) => {
				if (error) (Object.assign(error, { stdout, stderr }), reject(error));
				else resolve({ stdout, stderr });
			}
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

function ttyCli(args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
	const harness = [
		'import os, pty, sys',
		'pid, fd = pty.fork()',
		'if pid == 0: os.execv(sys.argv[1], sys.argv[1:-1])',
		'sent = False',
		'seen = b""',
		'while True:',
		' try:',
		'  data = os.read(fd, 4096)',
		'  if not data: break',
		'  os.write(1, data)',
		'  seen = (seen + data)[-4096:]',
		'  if not sent and b"[y/N]" in seen:',
		'   os.write(fd, sys.argv[-1].encode())',
		'   sent = True',
		' except OSError: break',
		'_, status = os.waitpid(pid, 0)',
		'sys.exit(os.waitstatus_to_exitcode(status))'
	].join('\n');
	return new Promise((resolve, reject) => {
		const child = execFile(
			'python3',
			['-c', harness, NODE, CLI_BIN, ...args, input || '\x04'],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'tines_named_key' } },
			(error, stdout, stderr) => {
				if (error) (Object.assign(error, { stdout, stderr }), reject(error));
				else resolve({ stdout, stderr });
			}
		);
		child.stdin?.end();
	});
}

describe('workflow package CLI', () => {
	it('pins canonical state links and accepts only the exact historical state form', () => {
		const workflow = plan.resolved.workflows[0];
		const state = workflow.states[0];
		const workflowId = plan.allocation.records[workflow.id].id;
		const stateId = plan.allocation.records[state.id].id;
		expect(plan.operations).toContainEqual(
			expect.objectContaining({
				kind: 'state',
				local_id: state.id,
				href: `/workflows/${workflowId}?state=${stateId}#state-${stateId}`
			})
		);
		assertPlanBinding(plan);

		const legacy = structuredClone(plan);
		const legacyState = legacy.operations.find(
			(operation) => operation.kind === 'state' && operation.local_id === state.id
		)!;
		legacyState.href = `/workflows/${workflowId}#state-${stateId}`;
		expect(() => assertPlanBinding(legacy)).not.toThrow();

		for (const href of [
			`/workflows/wrong#state-${stateId}`,
			`/workflows/${workflowId}#state-wrong`,
			`/workflows/${workflowId}?extra=1#state-${stateId}`
		]) {
			const changed = structuredClone(plan);
			changed.operations.find(
				(operation) => operation.kind === 'state' && operation.local_id === state.id
			)!.href = href;
			expect(() => assertPlanBinding(changed)).toThrow('modified operations');
		}

		const changedWorkflow = structuredClone(plan);
		changedWorkflow.operations.find((operation) => operation.kind === 'workflow')!.href +=
			'?extra=1';
		expect(() => assertPlanBinding(changedWorkflow)).toThrow('modified operations');
	});

	it('exports canonical JSON and requires an ID for ambiguous workflow names', async () => {
		const ambiguous = await cli(['workflows', 'export', 'Source']).catch(
			(error) => error as { stderr: string }
		);
		expect(ambiguous.stderr).toContain('ambiguous; use an id');
		expect(requests.map((request) => request.path)).toEqual(['/api/v1/workflows?limit=100']);
		requests = [];
		const result = await cli(['workflows', 'export', 'wf_source']);
		expect(JSON.parse(result.stdout)).toEqual(document);
		expect(result.stdout.trim()).not.toContain('\n');
		expect(result.stderr).toBe('');
	});

	it('validates files and stdin, preserving structured invalid diagnostics and exit 1', async () => {
		const valid = await cli(['workflows', 'validate', packagePath, '--json']);
		expect(JSON.parse(valid.stdout)).toMatchObject({ valid: true, digest: document.digest });
		const invalid = (await cli(['workflows', 'validate', '-', '--json'], 'not-json').catch(
			(error) => error
		)) as unknown as { stdout: string; code: number };
		expect(invalid.code).toBe(1);
		expect(JSON.parse(invalid.stdout)).toMatchObject({
			valid: false,
			diagnostics: [{ code: 'invalid_json' }]
		});
	});

	it('writes a credential-free plan and renders the complete review', async () => {
		const result = await cli(['workflows', 'preview', packagePath, '--plan-out', planPath]);
		for (const phrase of [
			'Operations:',
			'Workflows and gates:',
			'Inputs:',
			'Original and rendered text:',
			'Context:',
			'Schedules:',
			'Routing capabilities:',
			'Skipped:'
		]) {
			expect(result.stdout).toContain(phrase);
		}
		for (const detail of [
			'input:1 filing_label: Filing label — Label used in instructions',
			'required: yes; default: qa; required states: none',
			'use:1 -> input:1 (1 occurrence)',
			'original: Review {{filing_label:qa}} work',
			'rendered: Review qa work'
		])
			expect(result.stdout).toContain(detail);
		expect(result.stdout.match(/create state state:1/g)).toHaveLength(1);
		const saved = readFileSync(planPath, 'utf8');
		expect(saved).toContain('"plan_token": "wip1.');
		expect(saved).toContain(baseUrl);
		expect(saved).not.toContain('tines_named_key');
	});

	it('downloads a foreign public URL without credentials and rechecks exact bytes before install', async () => {
		const seen: Array<Record<string, string | string[] | undefined>> = [];
		let sourceBody = canonicalizeLibraryValue(document);
		const source = createServer((request, response) => {
			seen.push(request.headers);
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end(sourceBody);
		});
		await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
		const sourceBase = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
		const publicUrl = `${sourceBase}/p/abcdefghijklmnopqrst`;
		const remotePlan = join(dir, 'remote-plan.json');
		try {
			await cli(['workflows', 'preview', publicUrl, '--plan-out', remotePlan, '--json']);
			expect(seen).toHaveLength(1);
			expect(seen[0].authorization).toBeUndefined();
			expect(seen[0].cookie).toBeUndefined();
			expect(seen[0].referer).toBeUndefined();
			expect(readFileSync(remotePlan, 'utf8')).not.toContain('tines_named_key');

			sourceBody = canonicalizeLibraryValue(
				await withLibraryDocumentDigest({ ...document, exported_at: document.exported_at + 1 })
			);
			requests = [];
			const changed = await cli([
				'workflows',
				'install',
				publicUrl,
				'--plan',
				remotePlan,
				'--confirm',
				plan.plan_digest
			]).catch((error) => error as { stderr: string });
			expect(changed.stderr).toContain('source changed since preview');
			expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
		} finally {
			await new Promise<void>((resolve) => source.close(() => resolve()));
		}
	});

	it('makes no install request without the exact prior-plan confirmation', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		requests = [];
		for (const args of [
			['workflows', 'install', packagePath, '--plan', planPath],
			['workflows', 'install', packagePath, '--plan', planPath, '--confirm', 'wrong']
		]) {
			await cli(args).catch(() => undefined);
			expect(requests.filter((request) => request.path === '/api/v1/library/install')).toEqual([]);
		}
	});

	it('rejects a valid changed file and destination base before any install POST', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		const changedPath = join(dir, 'changed.json');
		writeFileSync(
			changedPath,
			JSON.stringify(
				await withLibraryDocumentDigest({ ...document, exported_at: document.exported_at + 1 })
			)
		);
		for (const args of [
			['workflows', 'install', changedPath, '--plan', planPath, '--confirm', plan.plan_digest],
			[
				'workflows',
				'install',
				packagePath,
				'--plan',
				planPath,
				'--confirm',
				plan.plan_digest,
				'--url',
				`${baseUrl}/different`
			]
		]) {
			requests = [];
			await cli(args).catch(() => undefined);
			expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
		}
	});

	it('shows the full TTY review and installs only on an affirmative answer', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		requests = [];
		const declined = await ttyCli(
			['workflows', 'install', packagePath, '--plan', planPath],
			'n\n'
		).catch((error) => error as { stdout: string; stderr: string });
		expect(`${declined.stdout}${declined.stderr}`).toContain('installation declined');
		expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
		requests = [];
		await ttyCli(['workflows', 'install', packagePath, '--plan', planPath], '').catch(
			() => undefined
		);
		expect(requests.filter((request) => request.method === 'POST')).toEqual([]);
		requests = [];
		const accepted = await ttyCli(
			['workflows', 'install', packagePath, '--plan', planPath],
			'yes\n'
		);
		expect(accepted.stdout).toContain('Filing label');
		expect(accepted.stdout).toContain('use:1 -> input:1 (1 occurrence)');
		expect(requests.filter((request) => request.path === '/api/v1/library/install')).toHaveLength(
			1
		);
	}, 30_000);

	it('surfaces a real run-key refusal after confirmation', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		requests = [];
		const failed = await cli([
			'workflows',
			'install',
			packagePath,
			'--plan',
			planPath,
			'--confirm',
			plan.plan_digest,
			'--api-key',
			'tines_run_key'
		]).catch((error) => error as { stderr: string });
		expect(failed.stderr).toContain('run keys cannot install packages');
		expect(requests.filter((request) => request.path === '/api/v1/library/install')).toHaveLength(
			1
		);
	});

	it('rejects modified persisted review fields before confirmation or install', async () => {
		for (const mutate of [
			(saved: any) => (saved.plan.resolved.workflows[0].name = 'Tampered'),
			(saved: any) => (saved.plan.operations[0].name = 'Tampered'),
			(saved: any) => (saved.plan.budget.statements += 1)
		]) {
			await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
			const saved = JSON.parse(readFileSync(planPath, 'utf8'));
			mutate(saved);
			writeFileSync(planPath, JSON.stringify(saved));
			requests = [];
			await cli([
				'workflows',
				'install',
				packagePath,
				'--plan',
				planPath,
				'--confirm',
				plan.plan_digest
			]).catch(() => undefined);
			expect(requests).toEqual([]);
		}
	});

	it('commits the exact persisted plan only after confirmation', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		requests = [];
		const result = await cli([
			'workflows',
			'install',
			packagePath,
			'--plan',
			planPath,
			'--confirm',
			plan.plan_digest,
			'--json'
		]);
		expect(JSON.parse(result.stdout)).toMatchObject({
			id: 'plan_1',
			plan_digest: plan.plan_digest
		});
		expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			'GET /api/v1/library/installs/plan_1',
			'POST /api/v1/library/install'
		]);
		expect(requests[1].body).toEqual({
			document_json: JSON.stringify(document),
			plan_token: plan.plan_token,
			confirmation: { plan_digest: plan.plan_digest }
		});
	});
});

describe('workflow package helpers', () => {
	it('renders gates and full skill file contents', () => {
		const rendered = formatWorkflowPackageReview(plan);
		expect(rendered).toContain('Workflows and gates:');
		expect(rendered).toContain('Context:');
		expect(rendered).toContain('SKILL.md');
	});

	it('uses a receipt after an uncertain install without preparing a replacement', async () => {
		let installs = 0;
		let gets = 0;
		const receipt = {
			id: plan.plan_id,
			document_digest: plan.document_digest,
			plan_digest: plan.plan_digest
		} as never;
		const api = {
			getWorkflowPackageReceipt: async () => {
				gets++;
				if (gets === 1)
					throw new ApiError(404, { code: 'not_found', message: 'missing' }, 'missing');
				return receipt;
			},
			installWorkflowPackage: async () => {
				installs++;
				throw new ApiNetworkError(
					'POST',
					'/api/v1/library/install',
					baseUrl,
					new TypeError('lost response')
				);
			}
		};
		expect(await recoverOrInstall(api, JSON.stringify(document), plan)).toBe(receipt);
		expect({ installs, gets }).toEqual({ installs: 1, gets: 2 });
	});

	it('rejects a recovered receipt for a different signed plan', async () => {
		const api = {
			getWorkflowPackageReceipt: async () => ({
				id: 'another_plan',
				document_digest: plan.document_digest,
				plan_digest: plan.plan_digest
			}),
			installWorkflowPackage: async () => {
				throw new Error('must not install');
			}
		};
		await expect(recoverOrInstall(api as never, JSON.stringify(document), plan)).rejects.toThrow(
			'receipt does not match'
		);
	});

	it('does not load a source when the matching receipt already exists', async () => {
		const receipt = {
			id: plan.plan_id,
			document_digest: plan.document_digest,
			plan_digest: plan.plan_digest
		} as never;
		const loadSource = vi.fn(async () => {
			throw new Error('source is unavailable');
		});
		expect(
			await recoverOrInstall(
				{
					getWorkflowPackageReceipt: async () => receipt,
					installWorkflowPackage: async () => {
						throw new Error('must not install');
					}
				},
				loadSource,
				plan
			)
		).toBe(receipt);
		expect(loadSource).not.toHaveBeenCalled();
	});

	it('retries the identical request after an uncertain response and recovery 404', async () => {
		const bodies: unknown[] = [];
		let gets = 0;
		const receipt = {
			id: plan.plan_id,
			document_digest: plan.document_digest,
			plan_digest: plan.plan_digest
		} as never;
		const api = {
			getWorkflowPackageReceipt: async () => {
				gets++;
				throw new ApiError(404, { code: 'not_found', message: 'missing' }, 'missing');
			},
			installWorkflowPackage: async (body: unknown) => {
				bodies.push(body);
				if (bodies.length === 1)
					throw new ApiNetworkError(
						'POST',
						'/api/v1/library/install',
						baseUrl,
						new TypeError('lost response')
					);
				return receipt;
			}
		};
		expect(await recoverOrInstall(api as never, JSON.stringify(document), plan)).toBe(receipt);
		expect(gets).toBe(2);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toEqual(bodies[0]);
	});

	it('does not retry a deterministic expired, stale, or tampered rejection', async () => {
		for (const code of ['plan_expired', 'plan_stale', 'invalid_plan_token']) {
			let installs = 0;
			const api = {
				getWorkflowPackageReceipt: async () => {
					throw new ApiError(404, { code: 'not_found', message: 'missing' }, 'missing');
				},
				installWorkflowPackage: async () => {
					installs++;
					throw new ApiError(409, { code, message: code }, code);
				}
			};
			await expect(recoverOrInstall(api, JSON.stringify(document), plan)).rejects.toMatchObject({
				code
			});
			expect(installs).toBe(1);
		}
	});
});
