import {
	recordDispatchEffects,
	TEST_NOOP_DISPATCH_EFFECTS
} from '$lib/server/api/test-dispatch-effects';
import {
	compareLabelNames,
	defaultLabelColor,
	FULL_API_KEY_PERMISSIONS,
	LABEL_COLORS
} from '@tines/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROJECT, USER, addIssue, addRunner, seedBase } from '../supervisor/test-fixtures';
import { ApiFail, runAtomic, type ActorContext } from './core';
import { listIssues } from './issues';
import {
	addIssueLabels,
	createLabel,
	issueLabelInserts,
	labelInserts,
	deleteLabel,
	listLabels,
	listLabelsInternal,
	normalizeLabelName,
	removeIssueLabel,
	resolveOrCreateLabels,
	updateLabel
} from './labels';
import { createContextItem } from './context';
import { createRoutingRule, listRoutingRules } from './routing';
import { createTestDb, type TestDb } from './test-db';

const human: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/**
 * A run key: same user, bound to an agent run — the fenced actor. The key id
 * is left null so events do not need a seeded `api_key` row; every rule under
 * test keys off `agentRunId` alone.
 */
const runKey: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: false,
	agentRunId: 'arun_1',
	permissions: FULL_API_KEY_PERMISSIONS
};

let t: TestDb;
beforeEach(() => {
	t = createTestDb();
	seedBase(t);
});

const names = async () => (await listLabelsInternal(t.db, USER)).map((l) => l.name);

describe('normalizeLabelName', () => {
	it('trims and accepts ordinary names', () => {
		expect(normalizeLabelName('  bug  ')).toBe('bug');
		expect(normalizeLabelName('needs design!')).toBe('needs design!');
	});

	it('rejects empty, overlong, control-char, and leading-dash names', () => {
		for (const bad of ['', '   ', 'x'.repeat(51), 'a\nb', '-negated']) {
			expect(() => normalizeLabelName(bad)).toThrowError(ApiFail);
		}
	});

	it('reports the real cap however long the name is', () => {
		for (const long of ['x'.repeat(51), 'x'.repeat(5000)]) {
			expect(() => normalizeLabelName(long)).toThrowError('at most 50 characters');
		}
	});
});

describe('defaultLabelColor', () => {
	it('is deterministic and always a palette key', () => {
		expect(defaultLabelColor('bug')).toBe(defaultLabelColor('bug'));
		// Case-insensitive, so "Bug" and "bug" never disagree visually.
		expect(defaultLabelColor('Bug')).toBe(defaultLabelColor('bug'));
		for (const n of ['bug', 'p1', 'chore', 'infra', 'ux']) {
			expect(LABEL_COLORS).toContain(defaultLabelColor(n));
		}
	});
});

describe('the label library', () => {
	it('creates a label with a derived color and lists it with usage', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		expect(label.color).toBe(defaultLabelColor('bug'));
		expect(await listLabelsInternal(t.db, USER)).toEqual([
			expect.objectContaining({ name: 'bug', issue_count: 0 })
		]);
	});

	it('rejects a duplicate name case-insensitively', async () => {
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await expect(createLabel(t.db, t.env, human, { name: 'BUG' })).rejects.toMatchObject({
			status: 409,
			code: 'conflict'
		});
	});

	it('rejects a color outside the palette', async () => {
		await expect(
			createLabel(t.db, t.env, human, { name: 'bug', color: 'hotpink' as never })
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
	});

	it('renames, and allows a pure case change onto itself', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		const renamed = await updateLabel(t.db, t.env, human, label.id, { name: 'Bug' });
		expect(renamed.name).toBe('Bug');
		expect(await names()).toEqual(['Bug']);
	});

	it('refuses a rename onto another existing label', async () => {
		await createLabel(t.db, t.env, human, { name: 'bug' });
		const chore = await createLabel(t.db, t.env, human, { name: 'chore' });
		await expect(updateLabel(t.db, t.env, human, chore.id, { name: 'bug' })).rejects.toMatchObject({
			status: 409
		});
	});

	it('resolves a label by name as well as by id', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'bug' });
		const updated = await updateLabel(t.db, t.env, human, 'BUG', { color: 'teal' });
		expect(updated.id).toBe(label.id);
		expect(updated.color).toBe('teal');
	});

	it('deletes an in-use label, detaching it and reporting the count', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug']);
		const res = await deleteLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, 'bug');
		expect(res).toEqual({
			deleted: true,
			issue_count: 1,
			context_items_deleted: [],
			routing_rules_deleted: []
		});
		expect(await names()).toEqual([]);
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
	});

	it('404s on an unknown label', async () => {
		await expect(
			deleteLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, 'nope')
		).rejects.toMatchObject({ status: 404 });
	});

	it('filters every usage count by independent project and control authority', async () => {
		const label = await createLabel(t.db, t.env, human, { name: 'scoped' });
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_hidden', '${USER}', 'hidden', 1, 1);
		`);
		const visible = addIssue(t, { id: 'iss_visible', project: PROJECT });
		const hidden = addIssue(t, { id: 'iss_hidden', project: 'prj_hidden' });
		t.sqlite.exec(`
			INSERT INTO issue_label (issue_id, label_id, created_at)
			VALUES ('${visible}', '${label.id}', 1), ('${hidden}', '${label.id}', 1);
			INSERT INTO context_item
				(id, user_id, kind, name, description, project_id, label_id, position, version, created_at, updated_at)
			VALUES
				('ctx_visible', '${USER}', 'prompt', 'visible', '', '${PROJECT}', '${label.id}', 0, 1, 1, 1),
				('ctx_hidden', '${USER}', 'prompt', 'hidden', '', 'prj_hidden', '${label.id}', 1, 1, 1, 1);
			INSERT INTO routing_rule
				(id, user_id, project_id, label_id, targets, created_at, updated_at)
			VALUES
				('rul_visible', '${USER}', '${PROJECT}', '${label.id}', '[]', 1, 1),
				('rul_hidden', '${USER}', 'prj_hidden', '${label.id}', '[]', 1, 1);
		`);
		const scoped: ActorContext = {
			...human,
			apiKeyId: 'key_scoped',
			viaSession: false,
			permissions: {
				version: 1,
				projects: { access: 'read', scope: [PROJECT] },
				workspace: 'read',
				control_plane: 'none'
			},
			runRestriction: null
		};
		await expect(listLabels(t.db, scoped)).resolves.toEqual([
			expect.objectContaining({
				id: label.id,
				issue_count: 1,
				context_item_count: 1,
				routing_rule_count: 0
			})
		]);
	});
});

describe('label order', () => {
	// The client sorts optimistic chips itself; it may only do that if its
	// comparator agrees with what SQLite's `COLLATE NOCASE` actually returns.
	it('matches what the server reads back for accented and mixed-case names', async () => {
		const inputs = ['zeta', 'éclair', 'Bug', 'apple'];
		for (const name of inputs) await createLabel(t.db, t.env, human, { name });
		expect(await names()).toEqual([...inputs].sort(compareLabelNames));
	});
});

describe('applying labels to an issue', () => {
	it('creates unknown labels for a human and attaches them', async () => {
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'bug',
			'p1'
		]);
		expect(res.added.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(res.created.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(res.labels.map((l) => l.name)).toEqual(['bug', 'p1']);
	});

	it('is idempotent: re-adding attaches nothing and does not error', async () => {
		const issue = addIssue(t, { title: 'a' });
		const effects = recordDispatchEffects();
		await addIssueLabels(t.db, t.env, human, effects, issue, ['bug']);
		const again = await addIssueLabels(t.db, t.env, human, effects, issue, ['BUG']);
		expect(again.added).toEqual([]);
		expect(again.created).toEqual([]);
		expect(again.labels.map((l) => l.name)).toEqual(['bug']);
		expect(effects.count()).toBe(2);
	});

	it('dispatch effects: addIssueLabels signals before post-commit hydration', async () => {
		const issue = addIssue(t, { title: 'a' });
		const effects = recordDispatchEffects();
		await expect(
			addIssueLabels(
				t.db,
				t.env,
				human,
				{
					...effects,
					signalDispatch() {
						effects.signalDispatch();
						t.sqlite.exec('ALTER TABLE label RENAME TO label_after_commit');
					}
				},
				issue,
				['bug']
			)
		).rejects.toThrow();
		expect(effects.count()).toBe(1);
		expect(t.all('SELECT issue_id FROM issue_label')).toEqual([{ issue_id: issue }]);
		expect(t.all("SELECT type FROM event WHERE type = 'issue.labeled'")).toHaveLength(1);
	});

	it('dispatch effects: addIssueLabels stays silent when its batch rejects', async () => {
		const issue = addIssue(t, { title: 'a' });
		const effects = recordDispatchEffects();
		t.env.DB.batch = async () => {
			throw new Error('injected label-add batch failure');
		};
		await expect(addIssueLabels(t.db, t.env, human, effects, issue, ['bug'])).rejects.toThrow(
			'injected label-add batch failure'
		);
		expect(effects.count()).toBe(0);
		expect(t.all('SELECT id FROM label')).toEqual([]);
		expect(t.all('SELECT issue_id FROM issue_label')).toEqual([]);
	});

	it('dedupes within one request', async () => {
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'bug',
			'Bug'
		]);
		expect(res.added).toHaveLength(1);
	});

	it('accepts a Project/N reference as well as an id', async () => {
		const id = addIssue(t, { title: 'a' });
		const { number } = t.sqlite.prepare('SELECT number FROM issue WHERE id = ?').get(id) as {
			number: number;
		};
		const res = await addIssueLabels(
			t.db,
			t.env,
			human,
			TEST_NOOP_DISPATCH_EFFECTS,
			`demo/${number}`,
			['bug']
		);
		expect(res.labels.map((l) => l.name)).toEqual(['bug']);
	});

	it('404s on an unknown issue', async () => {
		await expect(
			addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, 'iss_nope', ['bug'])
		).rejects.toMatchObject({
			status: 404
		});
	});

	// A page that loaded before someone deleted a label still submits its id;
	// get-or-create must not turn that id into a label literally named `lbl_…`.
	const staleId = 'lbl_' + 'a'.repeat(16);

	it('422s on a stale label id rather than minting a label named after it', async () => {
		const issue = addIssue(t, { title: 'a' });
		await expect(
			addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [staleId])
		).rejects.toMatchObject({
			status: 422,
			code: 'unknown_label',
			details: { unknown: [staleId] }
		});
		await expect(
			addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [staleId])
		).rejects.toThrowError(/deleted/);
		expect(await names()).toEqual([]);
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
	});

	it('applies nothing when a stale id rides along with a good name', async () => {
		const issue = addIssue(t, { title: 'a' });
		await expect(
			addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug', staleId])
		).rejects.toMatchObject({ status: 422, code: 'unknown_label' });
		expect(await names()).toEqual([]);
	});

	it('still resolves a real label id', async () => {
		const issue = addIssue(t, { title: 'a' });
		const bug = await createLabel(t.db, t.env, human, { name: 'bug' });
		const res = await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			bug.id
		]);
		expect(res.added.map((l) => l.name)).toEqual(['bug']);
		expect(res.created).toEqual([]);
	});

	it('dispatch effects: removeIssueLabel signals a removal and not a missing label', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug']);
		const effects = recordDispatchEffects();
		await removeIssueLabel(t.db, t.env, human, effects, issue, 'bug');
		expect(effects.count()).toBe(1);
		await expect(removeIssueLabel(t.db, t.env, human, effects, issue, 'bug')).rejects.toMatchObject(
			{
				code: 'label_not_on_issue'
			}
		);
		expect(effects.count()).toBe(1);
	});

	it('dispatch effects: removeIssueLabel stays silent when its batch rejects', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug']);
		const effects = recordDispatchEffects();
		t.env.DB.batch = async () => {
			throw new Error('injected label-remove batch failure');
		};
		await expect(removeIssueLabel(t.db, t.env, human, effects, issue, 'bug')).rejects.toThrow(
			'injected label-remove batch failure'
		);
		expect(effects.count()).toBe(0);
		expect(t.all('SELECT issue_id FROM issue_label')).toEqual([{ issue_id: issue }]);
	});

	it('creates names that merely look like an id: the shape test is exact', async () => {
		const issue = addIssue(t, { title: 'a' });
		const nearly = ['lbl_short', 'lbl_' + 'a'.repeat(17), 'lbl_' + 'a'.repeat(15)];
		const res = await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, nearly);
		expect(res.created.map((l) => l.name)).toEqual(nearly);
	});

	it('removes a label by name, and 404s when it is not attached', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug', 'p1']);
		await removeIssueLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, 'BUG');
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels.map((l) => l.name)).toEqual(['p1']);
		await expect(
			removeIssueLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, 'bug')
		).rejects.toMatchObject({
			status: 404,
			code: 'label_not_on_issue'
		});
	});
});

describe('deleting a label that scopes context or routing', () => {
	/** A `docs` label scoping one skill and one rule. */
	async function scoped(): Promise<{ labelId: string; runner: string }> {
		const label = await createLabel(t.db, t.env, human, { name: 'docs' });
		const runner = addRunner(t);
		await createContextItem(t.db, t.env, human, {
			kind: 'skill',
			name: 'docs-audit',
			files: [{ path: 'SKILL.md', content: 'audit the docs' }],
			project_id: PROJECT,
			label_id: label.id
		});
		await createRoutingRule(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, {
			label_id: label.id,
			targets: [{ runner_id: runner }]
		});
		return { labelId: label.id, runner };
	}

	it('422s naming both the items and the rules it scopes', async () => {
		await scoped();
		await expect(
			deleteLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, 'docs')
		).rejects.toMatchObject({
			status: 422,
			code: 'label_in_use',
			details: {
				context_items: [{ kind: 'skill', name: 'docs-audit' }],
				routing_rules: [{ scope_label: 'label docs' }]
			}
		});
		// Nothing was touched by the refusal.
		expect(await names()).toEqual(['docs']);
		expect(t.all(`SELECT id FROM context_item`)).toHaveLength(1);
		expect((await listRoutingRules(t.db, USER)).length).toBe(1);
	});

	it('force deletes the rule with the label rather than broadening it', async () => {
		await scoped();
		const effects = recordDispatchEffects();
		const res = await deleteLabel(t.db, t.env, human, effects, 'docs', {
			force: true
		});
		expect(res.context_items_deleted.map((i) => i.name)).toEqual(['docs-audit']);
		expect(res.routing_rules_deleted.map((r) => r.scope_label)).toEqual(['label docs']);
		expect(await names()).toEqual([]);
		expect(t.all(`SELECT id FROM context_item`)).toEqual([]);
		// Deleted, not label-stripped: a surviving rule would silently route
		// everything the label used to narrow.
		expect(await listRoutingRules(t.db, USER)).toEqual([]);
		expect(t.all(`SELECT type FROM event WHERE type = 'routing_rule.deleted'`)).toHaveLength(1);
		expect(effects.count()).toBe(1);
	});

	it('requires delete authority for every attached context scope before changing anything', async () => {
		await scoped();
		t.sqlite.exec('DELETE FROM routing_rule');
		const restricted: ActorContext = {
			...human,
			apiKeyId: 'key_restricted',
			viaSession: false,
			permissions: {
				version: 1,
				projects: { access: 'write', scope: [PROJECT] },
				workspace: 'delete',
				control_plane: 'delete'
			},
			runRestriction: null
		};
		const before = {
			labels: t.all('SELECT id FROM label'),
			context: t.all('SELECT id FROM context_item'),
			rules: t.all('SELECT id FROM routing_rule'),
			events: t.all('SELECT id FROM event')
		};
		await expect(
			deleteLabel(t.db, t.env, restricted, TEST_NOOP_DISPATCH_EFFECTS, 'docs', {
				force: true
			})
		).rejects.toMatchObject({
			code: 'insufficient_permissions',
			details: { operation: 'context.delete', domain: 'project', access: 'delete' }
		});
		expect(t.all('SELECT id FROM label')).toEqual(before.labels);
		expect(t.all('SELECT id FROM context_item')).toEqual(before.context);
		expect(t.all('SELECT id FROM routing_rule')).toEqual(before.rules);
		expect(t.all('SELECT id FROM event')).toEqual(before.events);
	});

	it('rolls back the whole forced cascade when an attached context scope races', async () => {
		await scoped();
		t.sqlite.exec(`
			INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_raced', '${USER}', 'raced', 1, 1)
		`);
		const realBatch = t.env.DB.batch.bind(t.env.DB);
		let intercepted = false;
		t.env.DB.batch = async (statements) => {
			if (!intercepted) {
				intercepted = true;
				t.sqlite.exec("UPDATE context_item SET project_id='prj_raced', version=version+1");
			}
			return realBatch(statements);
		};

		await expect(
			deleteLabel(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, 'docs', { force: true })
		).rejects.toThrow();
		expect(t.all("SELECT id FROM label WHERE name='docs'")).toHaveLength(1);
		expect(t.all("SELECT id FROM context_item WHERE name='docs-audit'")).toHaveLength(1);
		expect(t.all('SELECT id FROM routing_rule')).toHaveLength(1);
		expect(t.all("SELECT id FROM event WHERE type IN ('context.deleted','label.deleted')")).toEqual(
			[]
		);
	});

	it('keeps deleteLabel silent when its forced deletion batch rejects', async () => {
		await scoped();
		const effects = recordDispatchEffects();
		t.env.DB.batch = async () => {
			throw new Error('injected label-delete batch failure');
		};
		await expect(deleteLabel(t.db, t.env, human, effects, 'docs', { force: true })).rejects.toThrow(
			'injected label-delete batch failure'
		);
		expect(effects.count()).toBe(0);
		expect(await names()).toEqual(['docs']);
		expect(await listRoutingRules(t.db, USER)).toHaveLength(1);
	});

	it('a label nothing scopes still deletes without force', async () => {
		await createLabel(t.db, t.env, human, { name: 'spare' });
		const effects = recordDispatchEffects();
		expect((await deleteLabel(t.db, t.env, human, effects, 'spare')).deleted).toBe(true);
		expect(effects.count()).toBe(0);
	});
});

describe('run keys and labels a routing rule is scoped to (D4)', () => {
	async function routedLabel(): Promise<string> {
		const label = await createLabel(t.db, t.env, human, { name: 'docs' });
		const runner = addRunner(t);
		await createRoutingRule(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, {
			label_id: label.id,
			targets: [{ runner_id: runner }]
		});
		return label.id;
	}

	it('refuses to let a run key apply one, and writes nothing', async () => {
		await routedLabel();
		const issue = addIssue(t, { title: 'a' });
		await expect(
			addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, ['docs'])
		).rejects.toMatchObject({
			status: 403,
			code: 'run_key_forbidden',
			details: { reason: 'routing_label', labels: ['docs'] }
		});
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
	});

	it('refuses to let a run key remove one', async () => {
		await routedLabel();
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['docs']);
		await expect(
			removeIssueLabel(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, 'docs')
		).rejects.toMatchObject({
			status: 403,
			details: { reason: 'routing_label' }
		});
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels.map((l) => l.name)).toEqual(['docs']);
	});

	it('leaves a label no rule routes on freely self-applicable', async () => {
		await routedLabel();
		await createLabel(t.db, t.env, human, { name: 'flaky' });
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'flaky'
		]);
		expect(res.added.map((l) => l.name)).toEqual(['flaky']);
		await removeIssueLabel(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, 'flaky');
	});

	it('does not fence a human or a named key', async () => {
		await routedLabel();
		const issue = addIssue(t, { title: 'a' });
		const res = await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'docs'
		]);
		expect(res.added.map((l) => l.name)).toEqual(['docs']);
	});
});

describe('the run-key vocabulary fence', () => {
	it('lets a run key apply a label that already exists', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		const res = await addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'BUG'
		]);
		expect(res.added.map((l) => l.name)).toEqual(['bug']);
		expect(res.created).toEqual([]);
	});

	it('422s on an unknown label, listing it and the known vocabulary', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await expect(
			addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug', 'invented'])
		).rejects.toMatchObject({
			status: 422,
			code: 'unknown_label',
			details: { unknown: ['invented'], known_labels: [{ name: 'bug' }] }
		});
	});

	it('keeps the run-key wording on a stale id, not the human one', async () => {
		const issue = addIssue(t, { title: 'a' });
		await expect(
			addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, [
				'lbl_' + 'a'.repeat(16)
			])
		).rejects.toThrowError(/Run keys can apply existing labels only/);
	});

	it('applies nothing at all when any name is unknown', async () => {
		const issue = addIssue(t, { title: 'a' });
		await createLabel(t.db, t.env, human, { name: 'bug' });
		await addIssueLabels(t.db, t.env, runKey, TEST_NOOP_DISPATCH_EFFECTS, issue, [
			'invented'
		]).catch(() => {});
		const { items } = await listIssues(t.db, USER, {}, { cursor: null, limit: 10 });
		expect(items[0].labels).toEqual([]);
		expect(await names()).toEqual(['bug']);
	});

	it('does not create labels for a run key even when resolving alone', async () => {
		await expect(resolveOrCreateLabels(t.db, runKey, ['fresh'])).rejects.toMatchObject({
			status: 422,
			code: 'unknown_label'
		});
		expect(await names()).toEqual([]);
	});
});

describe('reading and filtering by label', () => {
	let ids: Record<string, string>;
	beforeEach(async () => {
		ids = {
			both: addIssue(t, { title: 'both' }),
			bugOnly: addIssue(t, { title: 'bug only' }),
			none: addIssue(t, { title: 'none' })
		};
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, ids.both, ['bug', 'p1']);
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, ids.bugOnly, ['bug']);
	});

	const search = async (labels?: string[]) =>
		(await listIssues(t.db, USER, { labels }, { cursor: null, limit: 50 })).items;

	it('rides along on every read, ordered by name', async () => {
		const items = await search();
		const both = items.find((i) => i.id === ids.both)!;
		expect(both.labels.map((l) => l.name)).toEqual(['bug', 'p1']);
		expect(items.find((i) => i.id === ids.none)!.labels).toEqual([]);
	});

	it('narrows on one label', async () => {
		expect((await search(['bug'])).map((i) => i.id).sort()).toEqual([ids.both, ids.bugOnly].sort());
	});

	it('ANDs repeated labels rather than widening', async () => {
		expect((await search(['bug', 'p1'])).map((i) => i.id)).toEqual([ids.both]);
	});

	it('matches label names case-insensitively', async () => {
		expect((await search(['BUG'])).map((i) => i.id).sort()).toEqual([ids.both, ids.bugOnly].sort());
	});

	it('returns nothing (not an error) for an unknown label', async () => {
		expect(await search(['nonexistent'])).toEqual([]);
	});

	it('matches by label id too', async () => {
		const bug = (await listLabelsInternal(t.db, USER)).find((l) => l.name === 'bug')!;
		expect((await search([bug.id])).map((i) => i.id).sort()).toEqual(
			[ids.both, ids.bugOnly].sort()
		);
	});
});

/**
 * Two requests can both miss the resolve for a brand-new name and both mint an
 * id. Driven through the exported pieces because the interleaving cannot be
 * produced through a single public call.
 */
describe('losing a get-or-create race', () => {
	it('attaches the winner’s label instead of failing on the unique index', async () => {
		const issue = addIssue(t, { title: 'a' });
		// Request A resolves first: "bug" does not exist, so an id is minted.
		const mine = await resolveOrCreateLabels(t.db, human, ['bug']);
		// Request B lands in between and creates "bug" with a different id.
		const winner = await createLabel(t.db, t.env, human, { name: 'bug' });
		expect(mine.toCreate[0].id).not.toBe(winner.id);

		// Now A's batch runs. Before, its label insert hit `label_user_name_uq`
		// and surfaced as a 500; now it is ignored and the attach binds by name.
		await runAtomic(t.env, [
			...labelInserts(t.db, human, mine.toCreate),
			...issueLabelInserts(t.db, human, { id: issue, project_id: PROJECT }, mine.labels, 1)
		]);

		// One label in the library, used once, and the attach points at it.
		expect((await listLabelsInternal(t.db, USER)).map((l) => `${l.name}:${l.issue_count}`)).toEqual(
			['bug:1']
		);
		const { items } = await listIssues(
			t.db,
			USER,
			{ labels: ['bug'] },
			{ cursor: null, limit: 50 }
		);
		expect(items.map((i) => i.labels.map((l) => l.id))).toEqual([[winner.id]]);
	});
});

describe('label reads are scoped to the owner', () => {
	/**
	 * Defence in depth: no write path can attach another user's label, but the
	 * read SQL should not be the only thing standing on that being true.
	 */
	it('ignores a cross-user issue_label row on both the read and the filter', async () => {
		const issue = addIssue(t, { title: 'a' });
		await addIssueLabels(t.db, t.env, human, TEST_NOOP_DISPATCH_EFFECTS, issue, ['bug']);
		t.sqlite.exec(`
			INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
				VALUES ('u2', 'bob', 'b@example.com', 1, 0, 0);
			INSERT INTO label (id, user_id, name, color, description, created_at, updated_at)
				VALUES ('lbl_foreign', 'u2', 'secret', 'red', '', 0, 0);
			INSERT INTO issue_label (issue_id, label_id, created_at)
				VALUES ('${issue}', 'lbl_foreign', 0);
		`);
		const page = { cursor: null, limit: 50 };
		const all = await listIssues(t.db, USER, {}, page);
		expect(all.items[0].labels.map((l) => l.name)).toEqual(['bug']);
		expect((await listIssues(t.db, USER, { labels: ['secret'] }, page)).items).toEqual([]);
		expect((await listIssues(t.db, USER, { labels: ['lbl_foreign'] }, page)).items).toEqual([]);
	});
});
