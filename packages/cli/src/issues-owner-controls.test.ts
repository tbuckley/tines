import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_BIN, NODE } from './test-bin.js';

const project = { id: 'prj_1', name: 'demo', shared_at: 1, sharing_revision: 1 };
const issue = {
	id: 'iss_1',
	project_id: project.id,
	project_name: project.name,
	number: 1,
	title: 'Owner',
	state: { id: 'open', name: 'Open', category: 'active' },
	allowed_transitions: [
		{
			transition_id: 'tr_1',
			name: 'Review',
			to_state: { id: 'review', name: 'Review', category: 'awaiting_human' }
		}
	]
};
const permission = {
	actor: 'owner',
	project: { id: project.id, sharing_revision: 1 },
	issue_state: { id: 'open', category: 'active', decision_revision: 4, workflow_revision: 7 },
	my_agents: { value: 'on', source: 'explicit_issue', revision: 3, epoch: 2 },
	agent_hold: { held: false, revision: 5 },
	readiness: 'eligible',
	admitted_run: null,
	committed_atomically: true
};
let server: Server;
let baseUrl: string;
const writes: { path: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
	server = createServer((req, res) => {
		const path = new URL(req.url ?? '/', 'http://localhost').pathname;
		res.setHeader('content-type', 'application/json');
		const send = (value: unknown) => res.end(JSON.stringify(value));
		if (req.method === 'GET') {
			if (path === '/api/v1/projects') return send({ items: [project], next_cursor: null });
			if (path === '/api/v1/projects/prj_1') return send(project);
			if (path === '/api/v1/projects/prj_1/issues/1') return send(issue);
			if (path === '/api/v1/issues/iss_1/my-consent') {
				if (req.headers.authorization === 'Bearer run') {
					res.statusCode = 403;
					return send({ error: { code: 'run_key_forbidden', message: 'Run keys cannot' } });
				}
				return send(permission);
			}
		}
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			writes.push({ path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
			if (path.endsWith('/transition'))
				return send({ ...issue, state: issue.allowed_transitions[0].to_state });
			if (path.endsWith('/agent-hold'))
				return send({ issue_id: issue.id, held: true, revision: 6, released_assigned: 0 });
			if (path.endsWith('/cancel')) return send({ id: 'arun_1', status: 'running' });
			res.statusCode = 404;
			return send({ error: { code: 'not_found', message: 'no' } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cli(args: string[], key = 'test') {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			NODE,
			[CLI_BIN, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: key }, timeout: 60_000 },
			(error, stdout, stderr) =>
				resolve({ code: (error as { code?: number } | null)?.code ?? 0, stdout, stderr })
		);
	});
}

it('moves with the exact witness and no CLI permission input', async () => {
	writes.length = 0;
	const result = await cli(['issues', 'move', 'demo/1', 'Review', '--json']);
	expect(result.code, result.stderr).toBe(0);
	expect(writes).toEqual([
		{
			path: '/api/v1/issues/iss_1/transition',
			body: {
				transition_id: 'tr_1',
				expected_state_id: 'open',
				expected_decision_revision: 4,
				expected_workflow_revision: 7,
				expected_consent_revision: 3,
				expected_consent_epoch: 2
			}
		}
	]);
});

it('moves a run key by exact transition when it cannot read personal permission', async () => {
	writes.length = 0;
	const result = await cli(['issues', 'move', 'demo/1', 'Review', '--json'], 'run');
	expect(result.code, result.stderr).toBe(0);
	expect(writes).toEqual([
		{ path: '/api/v1/issues/iss_1/transition', body: { transition_id: 'tr_1' } }
	]);
});

it('holds with the fresh revision and cancels only within the issue', async () => {
	writes.length = 0;
	const held = await cli(['issues', 'hold', 'demo/1', '--json']);
	expect(held.code, held.stderr).toBe(0);
	expect(writes.at(-1)).toEqual({
		path: '/api/v1/issues/iss_1/agent-hold',
		body: {
			held: true,
			expected_revision: 5
		}
	});
	const canceled = await cli(['issues', 'cancel-run', 'demo/1', 'arun_1', '--json']);
	expect(canceled.code, canceled.stderr).toBe(0);
	expect(writes.at(-1)?.path).toBe('/api/v1/issues/iss_1/runs/arun_1/cancel');
});
