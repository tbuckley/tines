/**
 * The CLI half of state inheritance (Tines/240), against a stub API: that
 * `workflows show` names a state's base and the states inheriting from it —
 * including across workflows, which is the only reason the whole library is
 * fetched — that `workflows bases` inverts the pointers, and that a
 * `"<workflow>/<state>"` pair in a create/edit body reaches the API as the
 * state id it wants. The server's own 422s are surfaced, not re-worded.
 */
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, '..', 'node_modules', '.bin', 'tsx');
const entry = join(here, 'index.ts');

const state = (
	id: string,
	name: string,
	category: string,
	position: number,
	inherits_from: string | null = null
) => ({ id, name, category, position, inherits_from });

/**
 * Two workflows, so `Engineering / Design` is a base with one child beside it
 * and one in another workflow — the case a single-workflow response cannot
 * answer.
 */
const engineering = {
	id: 'wf_eng',
	name: 'Engineering',
	description: 'The main pipeline',
	is_system: false,
	initial_state_id: 'wfs_design',
	states: [
		state('wfs_design', 'Design', 'active', 0),
		state('wfs_merge', 'Merging', 'active', 1, 'wfs_design')
	],
	transitions: [
		{ id: 'wft_1', name: 'approve', from_state_id: 'wfs_design', to_state_id: 'wfs_merge' }
	],
	issue_count: 4,
	created_at: 0,
	updated_at: 0
};

const review = {
	id: 'wf_rev',
	name: 'Review',
	description: '',
	is_system: false,
	initial_state_id: 'wfs_triage',
	states: [
		state('wfs_triage', 'Triage', 'active', 0, 'wfs_design'),
		state('wfs_done', 'Done', 'done', 1)
	],
	transitions: [
		{ id: 'wft_2', name: 'finish', from_state_id: 'wfs_triage', to_state_id: 'wfs_done' }
	],
	issue_count: 0,
	created_at: 0,
	updated_at: 0
};

/** A library with the same shape but no pointers at all. */
const flat = [
	{ ...engineering, states: [state('wfs_design', 'Design', 'active', 0)] },
	{ ...review, states: [state('wfs_done', 'Done', 'done', 0)], initial_state_id: 'wfs_done' }
];

let server: Server;
let baseUrl: string;
/** The library this run's stub serves — swapped by the empty-library case. */
let library: unknown[] = [engineering, review];
/** What the CLI sent, so the resolved `inherits_from` can be read off it. */
const seen: { method: string; path: string; body: unknown }[] = [];
/** When set, the next write answers with this 422 instead of succeeding. */
let failNextWrite: { code: string; message: string } | null = null;

beforeAll(async () => {
	server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			seen.push({
				method: req.method ?? '',
				path: url.pathname,
				body: raw ? JSON.parse(raw) : undefined
			});
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			if (url.pathname === '/api/v1/workflows' && req.method === 'GET') {
				return send(200, { items: library, next_cursor: null });
			}
			if (url.pathname === '/api/v1/workflows' || url.pathname.startsWith('/api/v1/workflows/')) {
				if (failNextWrite) {
					const error = failNextWrite;
					failNextWrite = null;
					return send(422, { error });
				}
				// The write echoes the library's Engineering back: these tests are
				// about what the CLI *sends*, and about how the result is printed.
				return send(200, engineering);
			}
			send(404, { error: { code: 'not_found', message: 'no' } });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	seen.length = 0;
	library = [engineering, review];
	failNextWrite = null;
});

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = execFile(
			tsx,
			[entry, ...args],
			{ env: { ...process.env, TINES_API_URL: baseUrl, TINES_API_KEY: 'k' }, timeout: 60_000 },
			(err, stdout, stderr) => {
				const code = (err as { code?: number } | null)?.code ?? 0;
				resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
			}
		);
		child.stdin?.end();
	});
}

/** The `states:` block of a `workflows show`, which is where inheritance renders. */
const statesBlock = (stdout: string) =>
	stdout.slice(stdout.indexOf('states:'), stdout.indexOf('\ntransitions:')).trimEnd();

describe('tines workflows show', () => {
	it('names the base under the child and the children under the base', async () => {
		const res = await cli(['workflows', 'show', 'Engineering']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(statesBlock(res.stdout)).toMatchInlineSnapshot(`
			"states:
			  Design   active  (initial)
			    inherited by: Engineering / Merging, Review / Triage
			  Merging  active
			    inherits from: Engineering / Design"
		`);
	}, 60_000);

	it('names a base living in another workflow', async () => {
		const res = await cli(['workflows', 'show', 'Review']);
		expect(res.code).toBe(0);
		// Not the bare `wfs_design`: naming it takes the whole library.
		expect(statesBlock(res.stdout)).toMatchInlineSnapshot(`
			"states:
			  Triage  active  (initial)
			    inherits from: Engineering / Design
			  Done    done"
		`);
	}, 60_000);

	it('says nothing about inheritance for a library with no pointers', async () => {
		library = flat;
		const res = await cli(['workflows', 'show', 'Engineering']);
		expect(res.code).toBe(0);
		expect(res.stdout).not.toContain('inherits from:');
		expect(res.stdout).not.toContain('inherited by:');
	}, 60_000);
});

describe('tines workflows bases', () => {
	it('lists each base with its children, grouped by workflow', async () => {
		const res = await cli(['workflows', 'bases']);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(res.stdout.trimEnd()).toMatchInlineSnapshot(`
			"Engineering
			  Design
			    inherited by: Engineering / Merging, Review / Triage"
		`);
	}, 60_000);

	it('reports an empty library the way every other list does', async () => {
		library = flat;
		const res = await cli(['workflows', 'bases']);
		expect(res.code).toBe(0);
		expect(res.stdout.trim()).toBe('no base states');
	}, 60_000);

	it('--json carries both ids and names for the base and each child', async () => {
		const res = await cli(['workflows', 'bases', '--json']);
		expect(res.code).toBe(0);
		expect(JSON.parse(res.stdout)).toEqual([
			{
				workflow: { id: 'wf_eng', name: 'Engineering' },
				state: { id: 'wfs_design', name: 'Design' },
				inherited_by: [
					{
						workflow: { id: 'wf_eng', name: 'Engineering' },
						state: { id: 'wfs_merge', name: 'Merging' }
					},
					{
						workflow: { id: 'wf_rev', name: 'Review' },
						state: { id: 'wfs_triage', name: 'Triage' }
					}
				]
			}
		]);
	}, 60_000);
});

/** The `inherits_from` each state in the last write carried. */
function sentStates(): { name: string; inherits_from?: unknown }[] {
	const write = seen.filter((r) => r.method !== 'GET').at(-1);
	return (write?.body as { states?: { name: string; inherits_from?: unknown }[] })?.states ?? [];
}

describe('tines workflows edit — resolving a <workflow>/<state> base', () => {
	const editWith = (inheritsFrom: unknown) =>
		cli([
			'workflows',
			'edit',
			'Engineering',
			JSON.stringify({
				states: [
					{ id: 'wfs_merge', name: 'Merging', category: 'active', inherits_from: inheritsFrom }
				]
			})
		]);

	it('sends the state id for a pair naming another workflow', async () => {
		const res = await editWith('Review/Triage');
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		expect(sentStates()).toEqual([
			{ id: 'wfs_merge', name: 'Merging', category: 'active', inherits_from: 'wfs_triage' }
		]);
		// Resolving the pair reuses the read the ref already needed.
		expect(seen.map((r) => r.method)).toEqual(['GET', 'PATCH', 'GET']);
	}, 60_000);

	it('accepts the spaced form `workflows show` prints', async () => {
		const res = await editWith('Engineering / Design');
		expect(res.code).toBe(0);
		expect(sentStates()[0].inherits_from).toBe('wfs_design');
	}, 60_000);

	it('passes null through, which is how a base is cleared', async () => {
		const res = await editWith(null);
		expect(res.code).toBe(0);
		expect(sentStates()[0].inherits_from).toBeNull();
		// One read before the write (the ref and any pair share it) and one
		// after, to name the pointers the result carries.
		expect(seen.map((r) => r.method)).toEqual(['GET', 'PATCH', 'GET']);
	}, 60_000);

	it('leaves a bare name alone, for the API to resolve against the request', async () => {
		const res = await editWith('Design');
		expect(res.code).toBe(0);
		expect(sentStates()[0].inherits_from).toBe('Design');
	}, 60_000);

	it('refuses an unknown state, naming the pair', async () => {
		const res = await editWith('Review/Nowhere');
		expect(res.code).not.toBe(0);
		expect(res.stderr.trim()).toBe(
			'error: state "Merging" inherits from "Review/Nowhere", but workflow "Review" ' +
				'has no state "Nowhere" (have: Triage, Done)'
		);
		expect(seen.some((r) => r.method === 'PATCH')).toBe(false);
	}, 60_000);

	it('refuses an unknown workflow, naming the pair', async () => {
		const res = await editWith('Nowhere/Triage');
		expect(res.code).not.toBe(0);
		expect(res.stderr.trim()).toBe(
			'error: state "Merging" inherits from "Nowhere/Triage", but there is no workflow ' +
				'"Nowhere" (have: Engineering, Review)'
		);
	}, 60_000);

	it("surfaces the server's cycle refusal verbatim", async () => {
		failNextWrite = {
			code: 'inheritance_cycle',
			message: 'Inheritance would loop: Merging → Design → Merging'
		};
		const res = await editWith('Engineering/Design');
		expect(res.code).not.toBe(0);
		expect(res.stderr.trim()).toBe(
			'error: Inheritance would loop: Merging → Design → Merging (inheritance_cycle)'
		);
	}, 60_000);

	it("surfaces the server's depth refusal verbatim", async () => {
		failNextWrite = {
			code: 'inheritance_too_deep',
			message: 'Inheritance chain is too long (max 3 states): A → B → C → D'
		};
		const res = await editWith('Engineering/Design');
		expect(res.code).not.toBe(0);
		expect(res.stderr.trim()).toBe(
			'error: Inheritance chain is too long (max 3 states): A → B → C → D (inheritance_too_deep)'
		);
	}, 60_000);
});

describe('tines workflows create — resolving a <workflow>/<state> base', () => {
	it('resolves the pair before posting', async () => {
		const res = await cli([
			'workflows',
			'create',
			JSON.stringify({
				name: 'Docs',
				initial_state: 'Writing',
				states: [
					{
						name: 'Writing',
						category: 'active',
						prompt: 'Write it.',
						inherits_from: 'Engineering/Design'
					}
				],
				transitions: []
			})
		]);
		expect(res.stderr).toBe('');
		expect(res.code).toBe(0);
		const post = seen.find((r) => r.method === 'POST');
		expect(post?.path).toBe('/api/v1/workflows');
		expect(sentStates()[0].inherits_from).toBe('wfs_design');
	}, 60_000);
});
