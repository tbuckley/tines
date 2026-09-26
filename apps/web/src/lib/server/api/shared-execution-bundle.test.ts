import { beforeEach, describe, expect, it } from 'vitest';
import {
	NOW,
	PROJECT,
	STAGE_A,
	STAGE_B,
	MEMBER,
	USER,
	addComment,
	addIssue,
	addLabel,
	addTwoStageWorkflow,
	seedBase
} from '../supervisor/test-fixtures';
import { createContextItem, effectiveContextForIssue } from './context';
import type { ActorContext } from './core';
import { ApiFail } from './core';
import {
	BUNDLE_ITEM_CAP,
	bundleWitnessExpr,
	loadSharedExecutionBundle,
	readSharedBundle,
	type BundleWitness
} from './shared-execution-bundle';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;
let issue: string;

const item = (fields: Record<string, unknown>) =>
	createContextItem(t.db, t.env, session, fields as never);
const prompt = (name: string, scope: Record<string, string> = {}, body = name.toUpperCase()) =>
	item({ kind: 'prompt', name, body, ...scope });
const load = (opts: Partial<Parameters<typeof loadSharedExecutionBundle>[2]> = {}) =>
	loadSharedExecutionBundle(t.env, t.db, { issueId: issue, skillFiles: true, ...opts });
const include = (itemId: string) =>
	t.sqlite
		.prepare(
			'INSERT INTO project_guidance_inclusion (project_id, context_item_id, created_at) VALUES (?, ?, ?)'
		)
		.run(PROJECT, itemId, NOW);
const liveVector = async (w: BundleWitness) =>
	(await t.db.selectNoFrom(bundleWitnessExpr(t.db, w).as('v')).executeTakeFirstOrThrow()).v;
const names = (b: Awaited<ReturnType<typeof load>>['bundle']) =>
	b.guidance.prompt.parts.map((p) => p.name);

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	t.sqlite.prepare('UPDATE project SET shared_at = ? WHERE id = ?').run(NOW, PROJECT);
	issue = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
});

describe('projection', () => {
	it('matches effectiveContextForIssue exactly when nothing is filtered out', async () => {
		await prompt('proj', { project_id: PROJECT });
		await prompt('state', { workflow_state_id: STAGE_A });
		await prompt('proj-state', { project_id: PROJECT, workflow_state_id: STAGE_A });
		await prompt('issue', { issue_id: issue });
		await item({
			kind: 'skill',
			name: 'sk',
			description: 'd',
			project_id: PROJECT,
			files: [{ path: 'SKILL.md', content: 'hello' }]
		});
		await item({
			kind: 'repo',
			name: 'r',
			repo_url: 'https://github.com/a/b',
			project_id: PROJECT
		});
		const { bundle } = await load();
		expect(bundle.guidance).toEqual(await effectiveContextForIssue(t.db, USER, issue));
		expect(bundle.guidance.skills[0].files).toEqual([{ path: 'SKILL.md', content: 'hello' }]);
	});

	it('shares global and label-only items only while included, and never env', async () => {
		const label = addLabel(t, 'ops');
		const other = addLabel(t, 'unrelated');
		const global = await prompt('global');
		const labelled = await prompt('labelled', { label_id: label });
		await prompt('other-project', { project_id: 'prj_elsewhere' }).catch(() => null);
		await item({ kind: 'env', name: 'SECRET_SENTINEL', value: 'sentinel-value', secret: false });
		expect(names((await load()).bundle)).toEqual([]);

		include(global.id);
		include(labelled.id);
		// The label clause still applies: an included label-only item needs the label.
		expect(names((await load()).bundle)).toEqual(['global']);
		t.sqlite
			.prepare('INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)')
			.run(issue, label, NOW);
		const { bundle } = await load();
		expect(names(bundle)).toEqual(['global', 'labelled']);
		expect(bundle.guidance.env).toEqual([]);
		const serialized = JSON.stringify(bundle);
		expect(serialized).not.toContain('sentinel-value');
		expect(serialized).not.toContain('SECRET_SENTINEL');
		expect(bundle.issue.label_vocabulary).toEqual(['ops']);
		expect(bundle.issue.label_vocabulary).not.toContain('unrelated');
		expect(other).toBeTruthy();
	});

	it('names the owner, the target and the journal', async () => {
		const { bundle, witness } = await load({ launchStateId: STAGE_A });
		expect(bundle).toMatchObject({
			version: 1,
			project: { id: PROJECT, owner: { id: USER, name: 'alice' } },
			target: { project_id: PROJECT, state_id: STAGE_A, state_chain: [STAGE_A] },
			journal: { anchor: 'run', item_id: null },
			requirements: []
		});
		expect(bundle.digest).toBe(witness.digest);
		expect(bundle.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a project that is not shared', async () => {
		t.sqlite.prepare('UPDATE project SET shared_at = NULL WHERE id = ?').run(PROJECT);
		await expect(load()).rejects.toMatchObject({ status: 404 });
	});
});

describe('caps and conflicts', () => {
	it('fails closed past the item cap', async () => {
		const insert = t.sqlite.prepare(
			`INSERT INTO context_item (id, user_id, kind, name, description, project_id, body, position, version, created_at, updated_at)
			VALUES (?, ?, 'prompt', ?, '', ?, 'x', ?, 1, ?, ?)`
		);
		for (let i = 0; i <= BUNDLE_ITEM_CAP; i++)
			insert.run(`ci_${i}`, USER, `p${i}`, PROJECT, i, NOW, NOW);
		await expect(load({ skillFiles: false })).rejects.toMatchObject({
			status: 422,
			code: 'bundle_too_large',
			details: { reason: 'item_cap' }
		});
	});

	it('fails closed past the size cap, counting file bytes without loading them', async () => {
		const big = 'x'.repeat(90 * 1024);
		for (let i = 0; i < 12; i++)
			await item({
				kind: 'skill',
				name: `sk${i}`,
				description: '',
				project_id: PROJECT,
				files: [{ path: 'SKILL.md', content: big }]
			});
		await expect(load({ skillFiles: false })).rejects.toMatchObject({
			code: 'bundle_too_large',
			details: { reason: 'size_cap' }
		});
	});

	it('refuses a repo checkout-directory conflict', async () => {
		await item({
			kind: 'repo',
			name: 'a',
			repo_url: 'https://github.com/x/same',
			project_id: PROJECT
		});
		await item({
			kind: 'repo',
			name: 'b',
			repo_url: 'https://github.com/y/same',
			workflow_state_id: STAGE_A
		});
		const err = await load().catch((e) => e);
		expect(err).toBeInstanceOf(ApiFail);
		expect(err).toMatchObject({
			status: 409,
			code: 'bundle_unavailable',
			details: { reason: 'repo_dir_conflict', dirs: ['same'] }
		});
	});
});

describe('witness', () => {
	it('changes on every input the bundle was built from, and not on unrelated edits', async () => {
		const label = addLabel(t, 'ops');
		const proj = await prompt('proj', { project_id: PROJECT });
		const skill = await item({
			kind: 'skill',
			name: 'sk',
			description: '',
			project_id: PROJECT,
			files: [{ path: 'SKILL.md', content: 'v1' }]
		});
		const global = await prompt('global');
		const { witness } = await load();
		let last = witness.vector;
		const changes = async (what: string, mutate: () => unknown, expected = true) => {
			await mutate();
			const now = await liveVector(witness);
			expect(now !== last, what).toBe(expected);
			last = now;
		};
		await changes(
			'unrelated other-issue item',
			async () => {
				const other = addIssue(t, { workflow: 'wf_two', state: STAGE_A });
				await prompt('elsewhere', { issue_id: other });
			},
			false
		);
		await changes('unshared global item', () => prompt('private-global'), false);
		await changes('new matching insert', () => prompt('late', { project_id: PROJECT }));
		await changes('prompt edit', () =>
			t.sqlite
				.prepare('UPDATE context_item SET body = ?, version = version + 1 WHERE id = ?')
				.run('B', proj.id)
		);
		await changes('skill file edit without a version bump', () =>
			t.sqlite
				.prepare(
					'UPDATE context_item_file SET content = ?, updated_at = ? WHERE context_item_id = ?'
				)
				.run('v22', NOW + 5, skill.id)
		);
		await changes('inclusion add', () => include(global.id));
		await changes('inclusion remove', () =>
			t.sqlite
				.prepare('DELETE FROM project_guidance_inclusion WHERE context_item_id = ?')
				.run(global.id)
		);
		await changes('label add', () =>
			t.sqlite
				.prepare('INSERT INTO issue_label (issue_id, label_id, created_at) VALUES (?, ?, ?)')
				.run(issue, label, NOW)
		);
		await changes('label rename', () =>
			t.sqlite.prepare('UPDATE label SET name = ? WHERE id = ?').run('ops2', label)
		);
		await changes('comment', () => addComment(t, { issueId: issue, body: 'hi', at: NOW + 9 }));
		await changes('rescope out', () =>
			t.sqlite.prepare('UPDATE context_item SET project_id = NULL WHERE id = ?').run(proj.id)
		);
		await changes('delete', () =>
			t.sqlite.prepare('DELETE FROM context_item WHERE id = ?').run(skill.id)
		);
		await changes('state inheritance edit', () =>
			t.sqlite
				.prepare('UPDATE workflow_state SET inherits_from_state_id = ? WHERE id = ?')
				.run(STAGE_B, STAGE_A)
		);
		await changes('transition', () =>
			t.sqlite.prepare('UPDATE issue SET state_id = ? WHERE id = ?').run(STAGE_B, issue)
		);
	});
});

describe('validation', () => {
	it('rebuilds once when the guidance changes between snapshot and validation', async () => {
		await prompt('proj', { project_id: PROJECT });
		const seen: number[] = [];
		const { bundle } = await load({
			beforeValidate: async (attempt) => {
				seen.push(attempt);
				if (attempt === 1) await prompt('racer', { project_id: PROJECT });
			}
		});
		expect(seen).toEqual([1, 2]);
		expect(names(bundle)).toEqual(['proj', 'racer']);
	});

	it('gives up as churn after two changed attempts', async () => {
		let n = 0;
		await expect(
			load({
				beforeValidate: async () => void (await prompt(`racer${++n}`, { project_id: PROJECT }))
			})
		).rejects.toMatchObject({
			status: 409,
			code: 'bundle_unavailable',
			details: { reason: 'churn' }
		});
		expect(n).toBe(2);
	});
});

describe('readers', () => {
	const human = (userId: string, userName: string): ActorContext => ({
		userId,
		userName,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true
	});
	const on = () => ({ ...t.env, SHARED_EXECUTION: 'on' }) as unknown as Env;
	const read = (actor: ActorContext, env: Env = on()) =>
		readSharedBundle(env, t.db, actor, issue, [], { skillFiles: false });

	beforeEach(() => {
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES
				('${MEMBER}', 'bob', 'b@example.com', 1, ${NOW}, ${NOW}),
				('u_out', 'eve', 'e@example.com', 1, ${NOW}, ${NOW});
			INSERT INTO project_member (project_id, user_id, revision, joined_at, updated_at)
				VALUES ('${PROJECT}', '${MEMBER}', 1, ${NOW}, ${NOW});
		`);
	});

	it('keeps today’s path with the flag off or in a never-shared project', async () => {
		expect(await read(session, t.env)).toBeNull();
		t.sqlite.prepare('UPDATE project SET shared_at = NULL WHERE id = ?').run(PROJECT);
		expect(await read(session)).toBeNull();
	});

	it('gives the owner and a member the same projection and digest, and an outsider 404', async () => {
		await prompt('proj', { project_id: PROJECT });
		await prompt('private-global');
		const owner = await read(session);
		const member = await read(human(MEMBER, 'bob'));
		expect(owner?.bundle.digest).toBe(member?.bundle.digest);
		expect(member?.bundle.guidance).toEqual(owner?.bundle.guidance);
		expect(names(member!.bundle)).toEqual(['proj']);
		await expect(read(human('u_out', 'eve'))).rejects.toMatchObject({ status: 404 });
	});
});
