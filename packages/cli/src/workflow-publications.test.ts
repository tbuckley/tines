import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');
const fixtureDir = mkdtempSync(join(tmpdir(), 'tines-publication-cli-'));
const packageFile = join(fixtureDir, 'workflow.json');
const proofFile = join(fixtureDir, 'publication-proof.json');
const digest = `sha256:${'a'.repeat(64)}`;
const snapshotId = 'abcdefghijklmnopqrst';

let server: Server;
let baseUrl: string;
const requests: Array<{ method: string; path: string; body: unknown }> = [];

beforeAll(async () => {
	writeFileSync(packageFile, '{}');
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => {
			const path = new URL(request.url ?? '/', 'http://localhost').pathname;
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
			requests.push({ method: request.method ?? '', path, body });
			const send = (value: unknown) => {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify(value));
			};
			if (path === '/api/v1/publications/validate')
				return send({
					valid: true,
					document_digest: digest,
					bytes_sha256: digest,
					byte_length: 2,
					diagnostics: [],
					limits: { max_document_bytes: 1048576 }
				});
			if (path === '/api/v1/publications/prepare')
				return send({
					candidate_id: 'pub_1',
					expires_at: Date.now() + 60_000,
					byte_length: 2,
					metadata: { display_name: 'CLI Author', license: 'MIT', license_year: 2026 },
					document: { context: [] },
					document_digest: digest,
					bytes_sha256: digest,
					review_digest: digest
				});
			if (path === '/api/v1/publications/pub_1/publish')
				return send({
					receipt: {
						public_url: `${baseUrl}/p/${snapshotId}`,
						snapshot_id: snapshotId,
						document_digest: digest,
						bytes_sha256: digest,
						review_digest: digest,
						published_at: Date.now(),
						status_version: 1
					},
					owner_state: 'published',
					host_state: 'active',
					status_version: 1
				});
			if (path.endsWith('/withdraw') || path.endsWith('/restore'))
				return send({
					receipt: { public_url: `${baseUrl}/p/${snapshotId}` },
					owner_state: path.endsWith('/withdraw') ? 'withdrawn' : 'published',
					host_state: 'active',
					status_version: 2
				});
			response.writeHead(404, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cli(args: string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		const child = execFile(
			tsx,
			[entry, ...args],
			{
				env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'user-key' },
				timeout: 60_000
			},
			(error, stdout, stderr) =>
				resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr })
		);
		child.stdin?.end();
	});
}

describe('workflow publication CLI contract', () => {
	it('validates under the public policy and saves a restrictive exact proof', async () => {
		expect((await cli(['workflows', 'validate', packageFile, '--public'])).code).toBe(0);
		const prepared = await cli([
			'workflows',
			'publish',
			'--from',
			packageFile,
			'--display-name',
			'CLI Author',
			'--proof-out',
			proofFile
		]);
		expect(prepared.code).toBe(0);
		expect(JSON.parse(readFileSync(proofFile, 'utf8'))).toMatchObject({
			format: 'tines.workflow-publication-proof',
			api_base: baseUrl,
			proof: { candidate_id: 'pub_1', review_digest: digest }
		});
		expect(statSync(proofFile).mode & 0o777).toBe(0o600);
	});

	it('commits the saved proof and reconciles management URLs explicitly', async () => {
		const published = await cli([
			'workflows',
			'publish',
			'--proof',
			proofFile,
			'--confirm',
			digest,
			'--sharing-rights'
		]);
		expect(published.code).toBe(0);
		expect(requests.some((request) => request.path === '/api/v1/publications/pub_1/publish')).toBe(
			true
		);
		const withdrawn = await cli(['workflows', 'unpublish', `${baseUrl}/p/${snapshotId}`, '--yes']);
		expect(withdrawn.code).toBe(0);
		expect(
			requests.some((request) => request.path === `/api/v1/publications/${snapshotId}/withdraw`)
		).toBe(true);
	});
});
