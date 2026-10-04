import { isHttpError } from '@sveltejs/kit';
import type { ContextItem } from '@tines/shared';
import { AGENT_GUIDELINES_NAME } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import type { IssuePagination } from '$lib/server/issue-pagination';
import { NOW, OPEN, PROJECT, USER, addIssue, seedBase } from '$lib/server/supervisor/test-fixtures';
import { load } from './+page.server';

type TestDb = ReturnType<typeof createTestDb>;

function fixture(): TestDb {
	const t = createTestDb();
	seedBase(t);
	return t;
}

function addItem(
	t: TestDb,
	item: {
		id: string;
		kind?: string;
		name?: string;
		updatedAt: number;
		user?: string;
		project?: string;
		state?: string;
		issue?: string;
		label?: string;
	}
): void {
	t.sqlite
		.prepare(
			`INSERT INTO context_item (id, user_id, kind, name, description, project_id,
				workflow_state_id, issue_id, label_id, body, config, position, version, created_at,
				updated_at)
			VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'b', ?, 0, 1, ?, ?)`
		)
		.run(
			item.id,
			item.user ?? USER,
			item.kind ?? 'prompt',
			item.name ?? item.id,
			item.project ?? null,
			item.state ?? null,
			item.issue ?? null,
			item.label ?? null,
			item.kind === 'artifact' ? JSON.stringify({ artifact_type: 'text' }) : null,
			NOW,
			item.updatedAt
		);
}

const pad = (n: number) => String(n).padStart(3, '0');

/** 101 artifacts on one issue, all newer than the single global prompt. */
function buriedPrompt(): TestDb {
	const t = fixture();
	const issue = addIssue(t);
	addItem(t, { id: 'ctx_prompt', updatedAt: NOW });
	for (let n = 1; n <= 101; n += 1) {
		addItem(t, { id: `ctx_art_${pad(n)}`, kind: 'artifact', issue, updatedAt: NOW + n });
	}
	return t;
}

function event(t: TestDb, query = '') {
	return {
		locals: { user: { id: USER } },
		platform: { env: t.env },
		url: new URL(`http://test/context${query}`),
		depends: () => {}
	} as unknown as Parameters<typeof load>[0];
}

/** The loader's return, narrowed: SvelteKit's generated type widens it to a record. */
interface Loaded {
	items: ContextItem[];
	filters: { kind?: string };
	hasAgentGuidelines: boolean;
	pagination: IssuePagination;
}
const run = async (t: TestDb, query = '') => (await load(event(t, query))) as unknown as Loaded;
const ids = (result: Loaded) => result.items.map((item) => item.id);
const queryOf = (href: string | null) => new URL(href!, 'http://test').search;

describe('Context page load', () => {
	it('hides artifacts by default, so guidance older than 100 artifacts still shows', async () => {
		const result = await run(buriedPrompt());
		expect(ids(result)).toEqual(['ctx_prompt']);
		expect(result.pagination.nextHref).toBeNull();
		expect(result.pagination.previousHref).toBeNull();
	});

	it('lists artifacts when asked for them, and says there are more', async () => {
		const result = await run(buriedPrompt(), '?kind=artifact');
		expect(result.items).toHaveLength(100);
		expect(result.items.every((item) => item.kind === 'artifact')).toBe(true);
		expect(ids(result)[0]).toBe('ctx_art_101');
		expect(result.pagination.nextHref).toContain('after=');
	});

	it('steps forward to the last page and back to the same first page', async () => {
		const t = fixture();
		for (let n = 1; n <= 101; n += 1) addItem(t, { id: `ctx_p_${pad(n)}`, updatedAt: NOW + n });
		const first = await run(t);
		expect(first.items).toHaveLength(100);
		expect(ids(first)[0]).toBe('ctx_p_101');
		expect(ids(first)[99]).toBe('ctx_p_002');
		expect(first.pagination.previousHref).toBeNull();

		const second = await run(t, queryOf(first.pagination.nextHref));
		expect(ids(second)).toEqual(['ctx_p_001']);
		expect(second.pagination.nextHref).toBeNull();
		expect(queryOf(second.pagination.previousHref)).toContain('page_scope=all');

		const back = await run(t, queryOf(second.pagination.previousHref));
		expect(ids(back)).toEqual(ids(first));
	});

	it('treats an unknown kind as the default view', async () => {
		const result = await run(buriedPrompt(), '?kind=bogus');
		expect(result.filters.kind).toBeUndefined();
		expect(ids(result)).toEqual(['ctx_prompt']);
	});

	it('finds the starter guidance by name however many prompts are newer', async () => {
		const t = fixture();
		addItem(t, { id: 'ctx_guidelines', name: AGENT_GUIDELINES_NAME, updatedAt: NOW });
		for (let n = 1; n <= 101; n += 1) addItem(t, { id: `ctx_p_${pad(n)}`, updatedAt: NOW + n });
		const result = await run(t);
		expect(ids(result)).not.toContain('ctx_guidelines');
		expect(result.hasAgentGuidelines).toBe(true);
	});

	it('does not count a project- or label-scoped prompt as the starter guidance', async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO label (id, user_id, name, color, created_at, updated_at)
			VALUES ('lbl_1', '${USER}', 'docs', 'gray', ${NOW}, ${NOW});`);
		addItem(t, {
			id: 'ctx_project',
			name: AGENT_GUIDELINES_NAME,
			project: PROJECT,
			updatedAt: NOW
		});
		addItem(t, { id: 'ctx_label', name: AGENT_GUIDELINES_NAME, label: 'lbl_1', updatedAt: NOW });
		expect((await run(t)).hasAgentGuidelines).toBe(false);
	});

	it("counts only the user's own global prompt of that exact name as the starter guidance", async () => {
		const t = fixture();
		t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('u2', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});`);
		const issue = addIssue(t);
		const named = { name: AGENT_GUIDELINES_NAME, updatedAt: NOW };
		addItem(t, { id: 'ctx_other_name', name: 'house-style', updatedAt: NOW });
		addItem(t, { id: 'ctx_other_user', user: 'u2', ...named });
		addItem(t, { id: 'ctx_skill', kind: 'skill', ...named });
		addItem(t, { id: 'ctx_state', state: OPEN, ...named });
		addItem(t, { id: 'ctx_issue', issue, ...named });
		expect((await run(t)).hasAgentGuidelines).toBe(false);
	});

	it('sends a cursor minted under another focus back to the first page, filters kept', async () => {
		const t = fixture();
		for (let n = 1; n <= 101; n += 1) addItem(t, { id: `ctx_p_${pad(n)}`, updatedAt: NOW + n });
		const next = queryOf((await run(t, '?kind=prompt')).pagination.nextHref);
		expect(next).toContain('page_scope=all');
		t.sqlite.exec(`INSERT INTO user_preference
			(user_id, focused_project_id, last_project_id, updated_at)
			VALUES ('${USER}', '${PROJECT}', '${PROJECT}', ${NOW});`);
		await expect(run(t, next)).rejects.toMatchObject({
			status: 303,
			location: '/context?kind=prompt'
		});
	});

	it("under a project focus, hides that project's issue artifacts by default and pages them on request", async () => {
		const t = fixture();
		const issue = addIssue(t);
		addItem(t, { id: 'ctx_global', updatedAt: NOW });
		addItem(t, { id: 'ctx_project', project: PROJECT, updatedAt: NOW });
		for (let n = 1; n <= 101; n += 1) {
			addItem(t, { id: `ctx_art_${pad(n)}`, kind: 'artifact', issue, updatedAt: NOW + n });
		}
		t.sqlite.exec(`INSERT INTO user_preference
			(user_id, focused_project_id, last_project_id, updated_at)
			VALUES ('${USER}', '${PROJECT}', '${PROJECT}', ${NOW});`);

		const byDefault = await run(t);
		expect(ids(byDefault)).toEqual(['ctx_project']);
		expect(byDefault.pagination.nextHref).toBeNull();

		const first = await run(t, '?kind=artifact');
		expect(first.items).toHaveLength(100);
		expect(ids(first)[0]).toBe('ctx_art_101');
		expect(queryOf(first.pagination.nextHref)).toContain(`page_scope=${PROJECT}`);

		const second = await run(t, queryOf(first.pagination.nextHref));
		expect(ids(second)).toEqual(['ctx_art_001']);
		expect(second.pagination.nextHref).toBeNull();
		expect(second.pagination.previousHref).not.toBeNull();
	});

	it('rejects an empty cursor with a 400 page, not an unexpected error', async () => {
		const rejection = await run(fixture(), '?after=').then(
			() => undefined,
			(e: unknown) => e
		);
		expect(isHttpError(rejection, 400)).toBe(true);
		expect(rejection).toMatchObject({ body: { message: 'Malformed pagination cursor' } });
	});
});
