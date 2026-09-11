import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ApiError,
	withLibraryDocumentDigest,
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { inheritedPackage } from '../../shared/src/library/fixtures.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';
import { formatWorkflowPackageReview, recoverOrInstall } from './workflow-packages.js';

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
		operations: [
			{
				action: 'create',
				kind: 'workflow',
				local_id: 'workflow:1',
				id: 'wf_new',
				name: 'Main',
				href: '/workflows/wf_new',
				relationship: 'main'
			},
			{
				action: 'skip',
				kind: 'schedule',
				local_id: 'schedule:1',
				id: null,
				name: 'Daily',
				href: null
			}
		],
		document,
		resolved: {
			choices: {},
			names: { 'workflow:1': 'Main' },
			inputs: [],
			labels: [],
			workflows: document.workflows,
			context: document.context,
			schedules: [],
			routing: [],
			patches: [],
			skipped: [{ kind: 'schedule', local_id: 'schedule:1' }]
		},
		allocation: { records: {}, labels: {} },
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
		else if (url.pathname === '/api/v1/library/install')
			result = response({
				id: 'receipt_1',
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

describe('workflow package CLI', () => {
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
		const saved = readFileSync(planPath, 'utf8');
		expect(saved).toContain('signed-secret-plan-token');
		expect(saved).toContain(baseUrl);
		expect(saved).not.toContain('tines_named_key');
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

	it('rejects a changed file, destination base, and run key before any install POST', async () => {
		await cli(['workflows', 'preview', packagePath, '--plan-out', planPath, '--json']);
		const changedPath = join(dir, 'changed.json');
		writeFileSync(
			changedPath,
			JSON.stringify({ ...document, exported_at: document.exported_at + 1 })
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
			],
			[
				'workflows',
				'install',
				packagePath,
				'--plan',
				planPath,
				'--confirm',
				plan.plan_digest,
				'--api-key',
				'trk_test_run_key'
			]
		]) {
			requests = [];
			await cli(args).catch(() => undefined);
			expect(requests.filter((request) => request.path === '/api/v1/library/install')).toEqual([]);
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
			id: 'receipt_1',
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
		const receipt = { id: 'receipt_1' } as never;
		const api = {
			getWorkflowPackageReceipt: async () => {
				gets++;
				if (gets === 1)
					throw new ApiError(404, { code: 'not_found', message: 'missing' }, 'missing');
				return receipt;
			},
			installWorkflowPackage: async () => {
				installs++;
				throw new TypeError('lost response');
			}
		};
		expect(await recoverOrInstall(api, JSON.stringify(document), plan)).toBe(receipt);
		expect({ installs, gets }).toEqual({ installs: 1, gets: 2 });
	});
});
