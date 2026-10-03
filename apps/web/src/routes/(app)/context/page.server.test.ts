/**
 * The Context page's loader against a real test database: focused on a
 * project shared with the viewer it must list that project's items (they
 * live in the owner's account) and nothing else of the owner's.
 */
import { describe, expect, it, vi } from 'vitest';
import { createContextItem } from '$lib/server/api/context';
import type { ActorContext } from '$lib/server/api/core';
import { actorForProject } from '$lib/server/api/project-access';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addLabel,
	NOW,
	OPEN,
	PROJECT,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';

// Lets a test land a write between the loader's access check and its final
// membership re-check (the label read sits in the wave between them).
const hooks = vi.hoisted(() => ({ beforeLabels: null as null | (() => void) }));
vi.mock('$lib/server/api/labels', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/api/labels')>();
	return {
		...real,
		listLabelsInternal: (...args: Parameters<typeof real.listLabelsInternal>) => {
			hooks.beforeLabels?.();
			return real.listLabelsInternal(...args);
		}
	};
});

import { load } from './+page.server';

const alice: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const bob: ActorContext = { ...alice, userId: 'u2', userName: 'Bob' };

type Loaded = {
	items: { name: string; kind: string; value?: string; value_set?: boolean }[];
	workflows: { id: string }[];
	labels: { name: string }[];
	viewerRole: 'owner' | 'member';
	sharedItemCount: number | null;
	hasAgentGuidelines: boolean;
	focusId: string | null;
};

async function setup() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt)
		VALUES ('u2','Bob','bob@example.com',1,${NOW},${NOW});
		UPDATE project SET shared_at = ${NOW}, sharing_revision = 1 WHERE id = '${PROJECT}';
		INSERT INTO project_member (project_id,user_id,revision,joined_at,updated_at)
		VALUES ('${PROJECT}','u2',1,${NOW},${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('prj_private', '${USER}', 'private', ${NOW}, ${NOW});
		INSERT INTO user_preference (user_id, focused_project_id, last_project_id, updated_at)
		VALUES ('u2','${PROJECT}','${PROJECT}',${NOW}), ('${USER}','${PROJECT}','${PROJECT}',${NOW});
	`);
	addLabel(t, 'owner-label');
	const issueId = addIssue(t, {});
	const prompt = (actor: ActorContext, name: string, scope: Record<string, string> = {}) =>
		createContextItem(t.db, t.env, actor, { kind: 'prompt', name, body: 'x', ...scope });
	await prompt(alice, 'GLOBAL_CANARY');
	await prompt(alice, 'STATE_CANARY', { workflow_state_id: OPEN });
	await prompt(alice, 'PRIVATE_CANARY', { project_id: 'prj_private' });
	await prompt(alice, 'owner-project', { project_id: PROJECT });
	await prompt(alice, 'owner-issue', { issue_id: issueId });
	await createContextItem(t.db, t.env, alice, {
		kind: 'env',
		name: 'SHARED_ENV',
		value: 'ENV_VALUE_CANARY',
		project_id: PROJECT
	});
	await prompt(bob, 'bob-own');
	await prompt(await actorForProject(t.db, bob, PROJECT), 'bob-shared', { project_id: PROJECT });
	return t;
}

function run(t: ReturnType<typeof createTestDb>, userId: string): Promise<Loaded> {
	const event = {
		locals: { user: { id: userId, name: userId } },
		platform: { env: t.env },
		url: new URL('http://test/context'),
		depends: vi.fn()
	};
	return (load as unknown as (e: typeof event) => Promise<Loaded>)(event);
}

describe('Context page loader', () => {
	it('lists a shared project own items for a member, and nothing else of the owner', async () => {
		const t = await setup();
		const data = await run(t, 'u2');
		expect(data.viewerRole).toBe('member');
		expect(data.focusId).toBe(PROJECT);
		expect(data.items.map((i) => i.name).sort()).toEqual(
			['SHARED_ENV', 'bob-shared', 'owner-issue', 'owner-project'].sort()
		);
		for (const canary of ['GLOBAL_CANARY', 'STATE_CANARY', 'PRIVATE_CANARY', 'ENV_VALUE_CANARY'])
			expect(JSON.stringify(data)).not.toContain(canary);
		const env = data.items.find((i) => i.kind === 'env')!;
		expect(env.value_set).toBe(true);
		expect(env).not.toHaveProperty('value');
		// The owner's private library count and the starter banner stay hidden.
		expect(data.sharedItemCount).toBeNull();
		expect(data.hasAgentGuidelines).toBe(true);
		// Filters come from the owner's library, as on the Issues page.
		expect(data.workflows.length).toBeGreaterThan(0);
		expect(data.labels.map((l) => l.name)).toEqual(['owner-label']);
	});

	it('refuses the load when the membership is removed while it runs', async () => {
		const t = await setup();
		// The access check passes; the removal lands before the final re-check.
		let removed = false;
		hooks.beforeLabels = () => {
			removed = true;
			t.sqlite.exec(`UPDATE project_member SET revoked_at = ${NOW} WHERE user_id = 'u2'`);
		};
		try {
			await expect(run(t, 'u2')).rejects.toMatchObject({ status: 404 });
		} finally {
			hooks.beforeLabels = null;
		}
		expect(removed).toBe(true);
	});

	it('leaves the owner focused load as it was', async () => {
		const t = await setup();
		const data = await run(t, USER);
		expect(data.viewerRole).toBe('owner');
		expect(data.items.map((i) => i.name).sort()).toEqual(
			['SHARED_ENV', 'bob-shared', 'owner-issue', 'owner-project'].sort()
		);
		// Global and state-scoped library items: the two canaries.
		expect(data.sharedItemCount).toBe(2);
		expect(data.hasAgentGuidelines).toBe(false);
		expect(data.items.find((i) => i.kind === 'env')!.value).toBe('ENV_VALUE_CANARY');
	});
});
