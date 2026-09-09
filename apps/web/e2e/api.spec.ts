import type {
	Comment,
	FleetQueue,
	IssueDetail,
	LabelWithUsage,
	ListResponse,
	Project,
	TinesEvent,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB, RUNROW } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

test.describe('auth', () => {
	test('rejects requests without a key', async ({ request }) => {
		const res = await request.get('/api/v1/projects');
		expect(res.status()).toBe(401);
	});

	test('rejects an invalid key', async ({ request }) => {
		const res = await apiClient(request, 'tines_not_a_real_key').get('/api/v1/projects');
		expect(res.status()).toBe(401);
		expect((await errorBody(res)).error.code).toBe('unauthorized');
	});

	test('accepts a seeded key', async ({ request }) => {
		const res = await apiClient(request, ALICE.apiKey).get('/api/v1/projects');
		expect(res.ok()).toBe(true);
	});

	test('refuses API-key management over bearer auth', async ({ request }) => {
		const res = await apiClient(request, ALICE.apiKey).post('/api/v1/api-keys', { name: 'nope' });
		expect(res.status()).toBe(403);
		expect((await errorBody(res)).error.code).toBe('session_required');
	});
});

// The fence a run key meets on the control plane. Reading the label library is
// the one hole in it: the launch prompt tells agents to run `tines labels list`
// to classify their own work, so that GET must answer them (Tines/169).
test.describe.serial('run-key fence', () => {
	const labelName = `fence-${runId}`;
	const labelDescription = 'What this term means — the field only the GET carries.';

	test('authenticates like any other key', async ({ request }) => {
		const res = await apiClient(request, RUNROW.runKey).get('/api/v1/projects');
		expect(res.ok()).toBe(true);
	});

	test('reads the label library, descriptions and all', async ({ request }) => {
		// Seeded by the run key's own user, so the read has something to find.
		// Asserted, so a rejected create fails here rather than as a missing
		// description below.
		const created = await apiClient(request, ALICE.apiKey).post('/api/v1/labels', {
			name: labelName,
			color: 'violet',
			description: labelDescription
		});
		expect(created.status()).toBe(201);

		const res = await apiClient(request, RUNROW.runKey).get('/api/v1/labels');
		expect(res.status()).toBe(200);
		const { items } = await body<ListResponse<LabelWithUsage>>(res);
		const seeded = items.find((l) => l.name === labelName);
		expect(seeded?.description).toBe(labelDescription);
	});

	test('still refuses to mint a term, naming what is forbidden', async ({ request }) => {
		const res = await apiClient(request, RUNROW.runKey).post('/api/v1/labels', {
			name: `nope-${runId}`,
			color: 'red'
		});
		expect(res.status()).toBe(403);
		const { error } = await errorBody(res);
		expect(error.code).toBe('run_key_forbidden');
		expect(error.message).toContain('create, rename, or delete labels');
	});

	test('still refuses to rename or delete an existing term', async ({ request }) => {
		const api = apiClient(request, RUNROW.runKey);
		const { items } = await body<ListResponse<LabelWithUsage>>(await api.get('/api/v1/labels'));
		const id = items.find((l) => l.name === labelName)?.id;
		expect(id).toBeTruthy();

		const renamed = await api.patch(`/api/v1/labels/${id}`, { name: `renamed-${runId}` });
		expect(renamed.status()).toBe(403);
		expect((await errorBody(renamed)).error.code).toBe('run_key_forbidden');

		const deleted = await api.delete(`/api/v1/labels/${id}`);
		expect(deleted.status()).toBe(403);
		expect((await errorBody(deleted)).error.code).toBe('run_key_forbidden');
	});

	test('leaves the rest of the control plane fenced, reads included', async ({ request }) => {
		for (const path of ['/api/v1/api-keys', '/api/v1/routing-rules', '/api/v1/preferences']) {
			const res = await apiClient(request, RUNROW.runKey).get(path);
			expect(res.status(), `GET ${path}`).toBe(403);
			expect((await errorBody(res)).error.code, `GET ${path}`).toBe('run_key_forbidden');
		}
	});

	// Tines/256: the fleet's shape is legible to a run — the reads behind
	// `tines supervisor status` and the Now row, and nothing else.
	test('opens the fleet reads to a run key, without the PAT hint', async ({ request }) => {
		const api = apiClient(request, RUNROW.runKey);
		for (const path of ['/api/v1/runners', '/api/v1/supervisor/queue']) {
			const res = await api.get(path);
			expect(res.status(), `GET ${path}`).toBe(200);
		}
		const settings = await api.get('/api/v1/supervisor/settings');
		expect(settings.status()).toBe(200);
		expect((await settings.json()).github_pat_hint).toBeNull();
		const queue = await body<FleetQueue>(await api.get('/api/v1/supervisor/queue'));
		expect(Array.isArray(queue.groups)).toBe(true);
		expect(typeof queue.waiting).toBe('number');
	});

	test('still fences the fleet writes', async ({ request }) => {
		const res = await apiClient(request, RUNROW.runKey).put('/api/v1/supervisor/settings', {
			enabled: true
		});
		expect(res.status()).toBe(403);
		expect((await errorBody(res)).error.code).toBe('run_key_forbidden');
	});
});

test.describe.serial('issue search', () => {
	// `q` is a substring match over title + description, and the global and
	// per-project routes must agree on it.
	const projectName = `search-${runId}`;
	let projectId: string;
	const titles = [`[idea] pagination ${runId}`, `Plain ${runId}`, `Other ${runId}`];

	test('seeds a project whose issues match on title, on description, or not at all', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;
		for (const [i, title] of titles.entries()) {
			const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
				title,
				description: i === 1 ? 'mentions pagination' : ''
			});
			expect(res.status()).toBe(201);
		}
	});

	const listBoth = async (
		api: ReturnType<typeof apiClient>,
		q: string
	): Promise<[string[], string[]]> => {
		const global = await body<ListResponse<IssueDetail>>(
			await api.get(`/api/v1/issues?project=${projectId}&q=${encodeURIComponent(q)}`)
		);
		const scoped = await body<ListResponse<IssueDetail>>(
			await api.get(`/api/v1/projects/${projectId}/issues?q=${encodeURIComponent(q)}`)
		);
		return [global.items.map((i) => i.title).sort(), scoped.items.map((i) => i.title).sort()];
	};

	test('matches titles and descriptions, on both routes', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const [global, scoped] = await listBoth(api, 'pagination');
		expect(global).toEqual([titles[0], titles[1]].sort());
		expect(scoped).toEqual(global);
	});

	test('treats brackets literally and ignores ASCII case', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const [brackets, scopedBrackets] = await listBoth(api, '[idea]');
		expect(brackets).toEqual([titles[0]]);
		expect(scopedBrackets).toEqual(brackets);
		const [upper] = await listBoth(api, 'IDEA');
		expect(upper).toEqual(brackets);
	});

	test('returns nothing for a term no issue carries', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		expect(await listBoth(api, `nothing-${runId}`)).toEqual([[], []]);
	});

	// brief=1 drops the description bodies that dominate a list payload. Both
	// list routes parse it, and nothing else about an item may change.
	test('omits only the description under brief=1, on both routes', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const paths = [`/api/v1/issues?project=${projectId}`, `/api/v1/projects/${projectId}/issues`];
		for (const path of paths) {
			const full = (await body<ListResponse<IssueDetail>>(await api.get(path))).items;
			const brief = (
				await body<ListResponse<IssueDetail>>(
					await api.get(`${path}${path.includes('?') ? '&' : '?'}brief=1`)
				)
			).items;
			expect(full.map((i) => i.description).sort(), path).toEqual(['', '', 'mentions pagination']);
			for (const [i, item] of brief.entries()) {
				expect(Object.hasOwn(item, 'description'), path).toBe(false);
				const { description: _description, ...rest } = full[i];
				expect(item, path).toEqual(rest);
			}
		}
	});
});

test.describe.serial('core issue loop', () => {
	const projectName = `loop-${runId}`;
	let projectId: string;
	let issueId: string;
	let submitTransitionId: string;

	test('creates a project, rejecting duplicate names', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const created = await api.post('/api/v1/projects', { name: projectName });
		expect(created.status()).toBe(201);
		projectId = (await body<Project>(created)).id;

		const dup = await api.post('/api/v1/projects', { name: projectName });
		expect(dup.status()).toBe(422);
		expect((await errorBody(dup)).error.code).toBe('duplicate_project_name');
	});

	test('creates issues with sequential numbers in the standard workflow', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const first = await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'First issue',
			description: 'Some **markdown**.'
		});
		expect(first.status()).toBe(201);
		const issue = await body<IssueDetail>(first);
		expect(issue.number).toBe(1);
		expect(issue.state.name).toBe('Open');
		expect(issue.workflow.is_system).toBe(true);
		expect(issue.allowed_transitions.map((t) => t.name).sort()).toEqual([
			'Abandon',
			'Submit for review'
		]);
		issueId = issue.id;
		submitTransitionId = issue.allowed_transitions.find(
			(t) => t.name === 'Submit for review'
		)!.transition_id;

		const second = await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Second issue'
		});
		expect((await body<IssueDetail>(second)).number).toBe(2);
	});

	test('rejects a transition that is not allowed, naming the legal moves', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'Approve' });
		expect(res.status()).toBe(422);
		const err = (await errorBody(res)).error;
		expect(err.code).toBe('invalid_transition');
		const allowed = err.details?.allowed_transitions as { name: string }[];
		expect(allowed.map((t) => t.name).sort()).toEqual(['Abandon', 'Submit for review']);
	});

	test('takes a named transition', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		// Action names match case-insensitively.
		const res = await api.post(`/api/v1/issues/${issueId}/transition`, {
			action: 'submit for review'
		});
		expect(res.ok()).toBe(true);
		expect((await body<IssueDetail>(res)).state.name).toBe('Human Review');
	});

	test('rejects replaying a transition from a state the issue left', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${issueId}/transition`, {
			transition_id: submitTransitionId
		});
		expect(res.status()).toBe(422);
		expect((await errorBody(res)).error.code).toBe('invalid_transition');
	});

	test('comments are attributed to the API key', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${issueId}/comments`, { body: 'Looks good.' });
		expect(res.status()).toBe(201);
		const comment = await body<{ actor: { user_name: string; api_key_name: string } }>(res);
		expect(comment.actor.user_name).toBe(ALICE.name);
		expect(comment.actor.api_key_name).toBe(ALICE.apiKeyName);
	});

	test('a comment can be edited and deleted, and both land on the event stream', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		const created = await body<Comment>(
			await api.post(`/api/v1/issues/${issueId}/comments`, { body: 'teh fix is in' })
		);
		expect(created.updated_at).toBeNull();

		const patched = await api.patch(`/api/v1/issues/${issueId}/comments/${created.id}`, {
			body: 'the fix is in'
		});
		expect(patched.status()).toBe(200);
		const edited = await body<Comment>(patched);
		expect(edited.body).toBe('the fix is in');
		expect(edited.updated_at).toBeGreaterThan(0);

		const detail = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(detail.comments.find((c) => c.id === created.id)?.updated_at).toBe(edited.updated_at);

		const removed = await api.delete(`/api/v1/issues/${issueId}/comments/${created.id}`);
		expect(removed.status()).toBe(204);
		const after = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(after.comments.map((c) => c.id)).not.toContain(created.id);

		const events = (
			await body<ListResponse<TinesEvent>>(await api.get(`/api/v1/events?issue=${issueId}`))
		).items;
		const editEvent = events.find((e) => e.type === 'issue.comment_edited');
		const deleteEvent = events.find((e) => e.type === 'issue.comment_deleted');
		expect(editEvent?.payload).toMatchObject({ comment_id: created.id, changed: ['body'] });
		expect(deleteEvent?.payload).toMatchObject({ comment_id: created.id, body_length: 13 });
		// The audit trail records the action, never the text.
		expect(JSON.stringify([editEvent?.payload, deleteEvent?.payload])).not.toContain('fix is in');
	});

	test('done issues drop out of the filtered list', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const approve = await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'Approve' });
		expect(approve.ok()).toBe(true);
		expect((await body<IssueDetail>(approve)).state.category).toBe('done');

		const hidden = await api.get(`/api/v1/issues?project=${projectId}&hide_done=1`);
		const hiddenIds = (await body<ListResponse<IssueDetail>>(hidden)).items.map((i) => i.id);
		expect(hiddenIds).not.toContain(issueId);

		const all = await api.get(`/api/v1/issues?project=${projectId}`);
		const allIds = (await body<ListResponse<IssueDetail>>(all)).items.map((i) => i.id);
		expect(allIds).toContain(issueId);
	});

	test('every step landed on the event stream', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.get(`/api/v1/events?issue=${issueId}`);
		const events = (await body<ListResponse<TinesEvent>>(res)).items;
		const types = events.map((e) => e.type);
		expect(types).toContain('issue.created');
		expect(types).toContain('issue.commented');
		expect(types.filter((t) => t === 'issue.transitioned')).toHaveLength(2);
		const transition = events.find(
			(e) => e.type === 'issue.transitioned' && e.payload.action === 'Approve'
		);
		expect(transition?.payload).toMatchObject({
			from_state_name: 'Human Review',
			to_state_name: 'Closed'
		});
	});

	test('concurrent transitions cannot both win', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const created = await api.post(`/api/v1/projects/${projectId}/issues`, { title: 'Race me' });
		const raceId = (await body<IssueDetail>(created)).id;

		const [a, b] = await Promise.all([
			api.post(`/api/v1/issues/${raceId}/transition`, { action: 'Submit for review' }),
			api.post(`/api/v1/issues/${raceId}/transition`, { action: 'Abandon' })
		]);
		const statuses = [a.status(), b.status()].sort();
		expect(statuses[0]).toBe(200);
		// The loser hits the compare-and-swap (409) or re-validation (422).
		expect([409, 422]).toContain(statuses[1]);

		// Exactly one transition event was recorded for the winner.
		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${raceId}`)
		);
		expect(events.items.filter((e) => e.type === 'issue.transitioned')).toHaveLength(1);
	});
});

test.describe.serial('workflow editing rules', () => {
	const wfName = `flow-${runId}`;
	let workflowId: string;
	let projectId: string;
	let issueId: string;
	let stateIds: Record<string, string>;

	test('the standard workflow is read-only', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const list = await body<ListResponse<WorkflowResponse>>(await api.get('/api/v1/workflows'));
		const standard = list.items.find((w) => w.is_system)!;
		expect(standard).toBeTruthy();

		const patch = await api.patch(`/api/v1/workflows/${standard.id}`, { name: 'Hacked' });
		expect(patch.status()).toBe(403);
		const del = await api.delete(`/api/v1/workflows/${standard.id}`);
		expect(del.status()).toBe(403);
	});

	test('creates a custom workflow and flags dead ends', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post('/api/v1/workflows', {
			name: wfName,
			initial_state: 'Todo',
			states: [
				{ name: 'Todo', category: 'backlog' },
				{ name: 'Doing', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{ name: 'start', from: 'Todo', to: 'Doing' },
				{ name: 'finish', from: 'Doing', to: 'Done' }
			]
		});
		expect(res.status()).toBe(201);
		const wf = await body<WorkflowResponse>(res);
		workflowId = wf.id;
		stateIds = Object.fromEntries(wf.states.map((s) => [s.name, s.id]));
		expect(wf.warnings ?? []).toEqual([]);

		// Removing Doing's exit leaves it stranded — allowed, but warned about.
		const updated = await api.patch(`/api/v1/workflows/${workflowId}`, {
			transitions: [{ name: 'start', from: stateIds.Todo, to: stateIds.Doing }]
		});
		expect(updated.ok()).toBe(true);
		const warned = await body<WorkflowResponse>(updated);
		expect(warned.warnings?.join(' ')).toContain('Doing');

		// Restore the finish transition for the tests below.
		const restored = await api.patch(`/api/v1/workflows/${workflowId}`, {
			transitions: [
				{ name: 'start', from: stateIds.Todo, to: stateIds.Doing },
				{ name: 'finish', from: stateIds.Doing, to: stateIds.Done }
			]
		});
		expect(restored.ok()).toBe(true);
	});

	test('cannot delete an occupied state or the initial state', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (
			await body<Project>(await api.post('/api/v1/projects', { name: `flow-prj-${runId}` }))
		).id;
		issueId = (
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${projectId}/issues`, {
					title: 'On the custom flow',
					workflow_id: workflowId
				})
			)
		).id;

		// The issue sits in Todo: removing Todo (redesignating the initial) is
		// rejected because the state is occupied.
		const occupied = await api.patch(`/api/v1/workflows/${workflowId}`, {
			initial_state: stateIds.Doing,
			states: [
				{ id: stateIds.Doing, name: 'Doing', category: 'active' },
				{ id: stateIds.Done, name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'finish', from: stateIds.Doing, to: stateIds.Done }]
		});
		expect(occupied.status()).toBe(422);
		expect((await errorBody(occupied)).error.code).toBe('state_in_use');

		// Dropping the initial state without designating a replacement gets the
		// spec-mandated guidance.
		const noInitial = await api.patch(`/api/v1/workflows/${workflowId}`, {
			states: [
				{ id: stateIds.Doing, name: 'Doing', category: 'active' },
				{ id: stateIds.Done, name: 'Done', category: 'done' }
			],
			transitions: [{ name: 'finish', from: stateIds.Doing, to: stateIds.Done }]
		});
		expect(noInitial.status()).toBe(422);
		expect((await errorBody(noInitial)).error.code).toBe('initial_state_removed');
	});

	test('cannot delete a workflow that issues reference', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.delete(`/api/v1/workflows/${workflowId}`);
		expect(res.status()).toBe(422);
		expect((await errorBody(res)).error.code).toBe('workflow_in_use');
	});

	test('renaming states keeps issue references intact', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const renamed = await api.patch(`/api/v1/workflows/${workflowId}`, {
			states: [
				{ id: stateIds.Todo, name: 'Backlog', category: 'backlog' },
				{ id: stateIds.Doing, name: 'Doing', category: 'active' },
				{ id: stateIds.Done, name: 'Done', category: 'done' }
			]
		});
		expect(renamed.ok()).toBe(true);
		const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(issue.state.id).toBe(stateIds.Todo);
		expect(issue.state.name).toBe('Backlog');
	});
});

test.describe('cross-user isolation', () => {
	test("bob cannot see alice's data, and shared workflow counts are scoped", async ({
		request
	}) => {
		const alice = apiClient(request, ALICE.apiKey);
		const bob = apiClient(request, BOB.apiKey);

		const project = await body<Project>(
			await alice.post('/api/v1/projects', { name: `iso-${runId}` })
		);
		const issue = await body<IssueDetail>(
			await alice.post(`/api/v1/projects/${project.id}/issues`, { title: 'Private to alice' })
		);

		expect((await bob.get(`/api/v1/projects/${project.id}`)).status()).toBe(404);
		expect((await bob.get(`/api/v1/issues/${issue.id}`)).status()).toBe(404);
		expect((await bob.post(`/api/v1/issues/${issue.id}/comments`, { body: 'hi' })).status()).toBe(
			404
		);

		const bobIssues = await body<ListResponse<IssueDetail>>(await bob.get('/api/v1/issues'));
		expect(bobIssues.items.map((i) => i.id)).not.toContain(issue.id);

		// Alice has issues on the shared standard workflow; bob's view of its
		// issue_count must not include them.
		const bobWorkflows = await body<ListResponse<WorkflowResponse>>(
			await bob.get('/api/v1/workflows')
		);
		const standard = bobWorkflows.items.find((w) => w.is_system)!;
		expect(standard.issue_count).toBe(0);

		// Bob can't route his issues onto alice's workflow either.
		const aliceWorkflows = await body<ListResponse<WorkflowResponse>>(
			await alice.get('/api/v1/workflows')
		);
		const custom = aliceWorkflows.items.find((w) => !w.is_system);
		if (custom) {
			const bobProject = await body<Project>(
				await bob.post('/api/v1/projects', { name: `iso-bob-${runId}` })
			);
			const res = await bob.post(`/api/v1/projects/${bobProject.id}/issues`, {
				title: 'Steal a workflow',
				workflow_id: custom.id
			});
			expect(res.status()).toBe(422);
		}
	});
});

test.describe.serial('direct state placement and workflow moves', () => {
	const projectName = `direct-${runId}`;
	let projectId: string;
	let issueId: string;

	test('an issue can start in any state of its workflow', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;

		const unknown = await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Bad start',
			state: 'Nowhere'
		});
		expect(unknown.status()).toBe(422);
		expect((await errorBody(unknown)).error.code).toBe('unknown_state');

		const res = await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Starts in review',
			state: 'Human Review'
		});
		expect(res.status()).toBe(201);
		const issue = await body<IssueDetail>(res);
		expect(issue.state.name).toBe('Human Review');
		issueId = issue.id;
	});

	test('PATCH state force-sets the state and records a forced move', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.patch(`/api/v1/issues/${issueId}`, { state: 'Closed' });
		expect(res.ok()).toBe(true);
		expect((await body<IssueDetail>(res)).state.name).toBe('Closed');

		const events = await body<ListResponse<TinesEvent>>(
			await api.get(`/api/v1/events?issue=${issueId}`)
		);
		const forced = events.items.find((e) => e.type === 'issue.transitioned');
		expect(forced?.payload.forced).toBe(true);
		expect(forced?.payload.from_state_name).toBe('Human Review');
		expect(forced?.payload.to_state_name).toBe('Closed');
	});

	test('PATCH workflow_id moves the issue onto another workflow', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const custom = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `direct-wf-${runId}`,
				initial_state: 'Todo',
				states: [
					{ name: 'Todo', category: 'backlog' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [{ name: 'finish', from: 'Todo', to: 'Done' }]
			})
		);

		// Without a state, the issue lands on the new workflow's initial state.
		const moved = await body<IssueDetail>(
			await api.patch(`/api/v1/issues/${issueId}`, { workflow_id: custom.id })
		);
		expect(moved.workflow.id).toBe(custom.id);
		expect(moved.state.name).toBe('Todo');

		// With one, it lands exactly where asked.
		const movedBack = await body<IssueDetail>(
			await api.patch(`/api/v1/issues/${issueId}`, { workflow_id: 'wf_standard', state: 'Closed' })
		);
		expect(movedBack.workflow.id).toBe('wf_standard');
		expect(movedBack.state.name).toBe('Closed');
	});
});

test.describe('input validation', () => {
	test('non-string fields are rejected, not stored', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const badDescription = await api.post('/api/v1/projects', {
			name: `valid-${runId}`,
			description: 42
		});
		expect(badDescription.status()).toBe(422);

		const badTitle = await api.post('/api/v1/projects', { name: '' });
		expect(badTitle.status()).toBe(422);
	});
});

test.describe.serial('issue label filter', () => {
	// `?label=` is repeatable and ANDs. Covered here rather than in a unit test
	// because the only thing joining `tines issues list --label` to the SQL is
	// `params.getAll('label')` in each route file, which unit tests never reach.
	const projectName = `labels-${runId}`;
	const bug = `bug-${runId}`;
	const p1 = `p1-${runId}`;
	let projectId: string;

	test('seeds issues carrying both labels, one label, and none', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;
		const seed = [
			{ title: 'Both', labels: [bug, p1] },
			{ title: 'Bug only', labels: [bug] },
			{ title: 'Unlabelled' }
		];
		for (const issue of seed) {
			const res = await api.post(`/api/v1/projects/${projectId}/issues`, issue);
			expect(res.status()).toBe(201);
			// Labels ride along on the create response, no follow-up read needed.
			expect((await body<IssueDetail>(res)).labels.map((l) => l.name)).toEqual(issue.labels ?? []);
		}
	});

	/** The same filter through the global route and the per-project route. */
	const listBoth = async (
		api: ReturnType<typeof apiClient>,
		...labels: string[]
	): Promise<[string[], string[]]> => {
		const qs = labels.map((l) => `label=${encodeURIComponent(l)}`).join('&');
		const global = await body<ListResponse<IssueDetail>>(
			await api.get(`/api/v1/issues?project=${projectId}&${qs}`)
		);
		const scoped = await body<ListResponse<IssueDetail>>(
			await api.get(`/api/v1/projects/${projectId}/issues?${qs}`)
		);
		return [global.items.map((i) => i.title).sort(), scoped.items.map((i) => i.title).sort()];
	};

	test('filters by one label, on both routes', async ({ request }) => {
		const [global, scoped] = await listBoth(apiClient(request, ALICE.apiKey), bug);
		expect(global).toEqual(['Both', 'Bug only']);
		expect(scoped).toEqual(global);
	});

	test('ANDs repeated labels rather than widening', async ({ request }) => {
		const [global, scoped] = await listBoth(apiClient(request, ALICE.apiKey), bug, p1);
		expect(global).toEqual(['Both']);
		expect(scoped).toEqual(global);
	});

	test('matches label names case-insensitively', async ({ request }) => {
		const [global] = await listBoth(apiClient(request, ALICE.apiKey), bug.toUpperCase());
		expect(global).toEqual(['Both', 'Bug only']);
	});

	test('returns nothing for a label no issue carries, without erroring', async ({ request }) => {
		expect(await listBoth(apiClient(request, ALICE.apiKey), `absent-${runId}`)).toEqual([[], []]);
	});
});

test.describe('method not allowed', () => {
	// Kit answers an unsupported verb on a real route itself, before any
	// handler runs; only the hook can put that in the envelope (Tines/83).
	const paths = ['/api/v1/projects', '/api/v1/runners', '/api/v1/issues/iss_nosuchissue/comments'];

	for (const path of paths) {
		for (const method of ['put', 'patch', 'delete'] as const) {
			test(`${method.toUpperCase()} ${path} answers the JSON error envelope`, async ({
				request
			}) => {
				const api = apiClient(request, ALICE.apiKey);
				const res = method === 'delete' ? await api.delete(path) : await api[method](path, {});
				expect(res.status()).toBe(405);
				expect(res.headers()['content-type']).toContain('application/json');
				expect(res.headers()['allow']).toBeTruthy();
				expect(await errorBody(res)).toEqual({
					error: {
						code: 'method_not_allowed',
						message: `${method.toUpperCase()} is not allowed on this resource`
					}
				});
			});
		}
	}

	test('a supported verb on the same route is untouched', async ({ request }) => {
		// The rewrite keys off the 405, so the happy path must not move: this
		// route's real PATCH still reaches its handler and 404s on the fake id.
		const res = await apiClient(request, ALICE.apiKey).patch(
			'/api/v1/issues/iss_nosuchissue/comments/cmt_nosuchcomment',
			{ body: 'x' }
		);
		expect(res.status()).toBe(404);
		expect((await errorBody(res)).error.code).toBe('not_found');
	});
});

test.describe('e2e helper: body() surfaces a failed request', () => {
	// Tines/157: `body()` used to return the error envelope typed as the created
	// object, so a `beforeAll` that 4xx'd looked like a successful seed and the
	// spec failed much later against undefined ids. These pin that a failed
	// request stops at the call that made it, naming the server's own reason.
	const projectName = `helper-body-${runId}`;

	test('throws with the server code and message instead of returning the envelope', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		expect((await api.post('/api/v1/projects', { name: projectName })).status()).toBe(201);

		// The exact Tines/31 shape: a second create under a name already taken.
		const dup = await api.post('/api/v1/projects', { name: projectName });
		await expect(body<Project>(dup)).rejects.toThrow(/422.*duplicate_project_name/s);
	});

	test('reports a non-JSON failure as its body, not a parse error', async ({ request }) => {
		// An unknown /api path falls out of the JSON API to Kit's HTML error
		// page. Reading 6KB of HTML as JSON throws a SyntaxError naming nothing;
		// the status, the URL and a truncated body at least say what happened.
		const res = await apiClient(request, ALICE.apiKey).get('/api/v1/no-such-endpoint');
		expect(res.status()).toBe(404);
		expect(res.headers()['content-type']).toContain('text/html');

		const err = await body(res).then(
			() => null,
			(e: Error) => e
		);
		expect(err?.message).toContain('404');
		expect(err?.message).toContain('/api/v1/no-such-endpoint');
		expect(err?.message).toContain('<!doctype html>');
		expect(err?.message).not.toContain('JSON');
		// Truncated: a whole error page would bury the status it is reported with.
		expect(err?.message.length).toBeLessThan(700);
	});

	test('errorBody() throws when the request unexpectedly succeeded', async ({ request }) => {
		// The inverse trap: `.error.code` on a 200 is `undefined`, which compares
		// equal to no expected code at all and reports an absent error as a
		// wrong one.
		const ok = await apiClient(request, ALICE.apiKey).get('/api/v1/projects');
		expect(ok.ok()).toBe(true);
		await expect(errorBody(ok)).rejects.toThrow(/Expected an error.*200/s);
	});
});
