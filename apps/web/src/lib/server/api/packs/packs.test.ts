import { describe, expect, it } from 'vitest';
import { type PackWireFile } from '@tines/shared';
import { packFilesFromRecord } from '@tines/shared/packs';
import { engineeringPack } from '../../../../../../../packages/shared/src/packs/engineering-fixture';
import { createTestDb } from '../test-db';
import { sessionActor, type ActorContext } from '../core';
import { effectiveContextForIssue, resolvedEnvForIssue, updateContextItem } from '../context';
import { createIssue } from '../issues';
import { updateWorkflow } from '../workflows';
import { loadEligibleIssues } from '../../supervisor/engine';
import { bytesToB64 } from './model';
import { exportPack, installPack, prepareInstall, prepareReplace, replacePack } from './install';
import {
	addPackWorkflow,
	createPack,
	createPackItem,
	detachPack,
	getPack,
	removePack,
	removePreview,
	setMySecrets,
	setPackValues,
	updatePack
} from './authoring';
import { listProjectPacks } from './views';

const KEY = 'a'.repeat(64);

function wire(record: Record<string, string>): PackWireFile[] {
	return packFilesFromRecord(record).map((f) => ({
		path: f.path,
		content_b64: bytesToB64(f.bytes)
	}));
}

function fixture() {
	const t = createTestDb();
	const env = { ...t.env, SECRET_ENCRYPTION_KEY: KEY } as unknown as Env;
	const now = Date.now();
	for (const id of ['owner', 'other'])
		t.sqlite
			.prepare(
				'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
			)
			.run(id, id, `${id}@test.invalid`, 1, now, now);
	for (const [id, name] of [
		['prj', 'acme'],
		['prj2', 'beta']
	])
		t.sqlite
			.prepare(
				'INSERT INTO project (id,user_id,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?)'
			)
			.run(id, 'owner', name, '', now, now);
	const owner: ActorContext = sessionActor({ id: 'owner', name: 'owner' });
	const effects = { signalDispatch: () => {} } as never;
	return { ...t, env, owner, effects };
}

async function install(
	t: ReturnType<typeof fixture>,
	record = engineeringPack(),
	extra: Record<string, unknown> = {}
) {
	const files = wire(record);
	const review = await prepareInstall(t.db, t.owner, 'prj', { files });
	expect(review.errors).toEqual([]);
	return installPack(t.db, t.env, t.owner, 'prj', {
		files,
		expected_digest: review.digest,
		values: {
			app_repo: { repo_url: 'https://github.com/acme/app' },
			escalation: { workflow_id: 'pack:engineering/review' }
		},
		my_secrets: { github_token: 'ghp_secret' },
		...extra
	});
}

async function issueIn(t: ReturnType<typeof fixture>, workflowId: string, state?: string) {
	return createIssue(t.db, t.env, t.owner, t.effects, 'prj', {
		title: 'Do it',
		workflow_id: workflowId,
		...(state ? { state } : {})
	} as never);
}

describe('packs: install', () => {
	it('reviews, installs and stitches a pack with rendered placeholders', async () => {
		const t = fixture();
		const files = wire(engineeringPack());
		const review = await prepareInstall(t.db, t.owner, 'prj', { files });
		expect(review.errors).toEqual([]);
		expect(review.requires_browser).toBe(true); // QA's test state is organization-wide
		expect(review.adds?.workflows.map((w) => w.key)).toEqual(['engineering', 'qa']);
		expect(review.inputs.find((i) => i.name === 'escalation')?.missing).toBe(true);

		const receipt = await install(t);
		expect(receipt.pack.kind).toBe('installed');
		expect(receipt.pack.version).toBe(4);
		expect(receipt.pack.needs_setup).toEqual([]);

		const detail = await getPack(t.db, t.owner, 'prj', receipt.pack.id);
		const eng = detail.workflows.find((w) => w.key === 'engineering')!;
		expect(eng.states.map((s) => s.key)).toEqual(['triage', 'implement', 'review', 'done']);
		const qa = detail.workflows.find((w) => w.key === 'qa')!;
		expect(qa.states[0].run_scope).toBe('workspace');

		const issue = await issueIn(t, eng.id, 'Implement');
		const ctx = await effectiveContextForIssue(t.db, 'owner', issue.id);
		// Project reach, then pack, workflow and state reach, in that order.
		const labels = ctx.prompt.parts.map((p) => `${p.scope.label}:${p.name}`);
		expect(labels).toEqual([
			'pack Engineering · project acme:conventions',
			'pack Engineering · shared:house-style',
			'pack Engineering · workflow Engineering:overview',
			'pack Engineering · state Engineering / Implement:instructions'
		]);
		expect(ctx.prompt.text).toContain('https://staging.example.com before handing off');
		expect(ctx.prompt.text).toContain('Reviewer: .'); // optional text renders empty
		expect(ctx.prompt.text).toContain(
			'File bugs in the "Engineering" workflow, starting in "Triage"'
		);
		expect(ctx.repos.find((r) => r.name === 'app')).toMatchObject({
			url: 'https://github.com/acme/app',
			branch: 'main'
		});
		expect(ctx.env.find((e) => e.name === 'API_BASE')?.value).toBe(
			'https://staging.example.com/api'
		);
		expect(ctx.env.find((e) => e.name === 'GITHUB_TOKEN')).toMatchObject({ secret: true });
		const skill = ctx.skills.find((s) => s.name === 'escalation')!;
		expect(skill.files[0].content).toContain(
			'Escalate to the "Engineering" workflow, starting in "Human review"'
		);
		expect(skill.files[0].content).toContain('{{ inputs.nope }} and {{ date }}');
		expect(ctx.missing_inputs).toBeUndefined();

		const env = await resolvedEnvForIssue(t.db, t.env, 'owner', issue.id);
		expect(env.find((e) => e.name === 'GITHUB_TOKEN')?.value).toBe('ghp_secret');

		// A QA issue does not get Engineering's workflow-level items.
		const qaIssue = await issueIn(t, qa.id);
		const qaCtx = await effectiveContextForIssue(t.db, 'owner', qaIssue.id);
		expect(qaCtx.prompt.parts.map((p) => p.name)).toEqual([
			'conventions',
			'house-style',
			'instructions'
		]);
	});

	it('refuses a second install of the same pack id and an upload that differs from the review', async () => {
		const t = fixture();
		await install(t);
		const files = wire(engineeringPack());
		const review = await prepareInstall(t.db, t.owner, 'prj', { files });
		expect(review.already_installed).not.toBeNull();
		await expect(
			installPack(t.db, t.env, t.owner, 'prj', { files, expected_digest: review.digest })
		).rejects.toMatchObject({
			code: 'already_installed'
		});
		const t2 = fixture();
		const other = wire({ ...engineeringPack(), 'README.md': 'changed' });
		await expect(
			installPack(t2.db, t2.env, t2.owner, 'prj', { files: other, expected_digest: review.digest })
		).rejects.toMatchObject({
			code: 'pack_digest_mismatch'
		});
	});

	it('requires a browser session for wide run scopes', async () => {
		const t = fixture();
		const files = wire(engineeringPack());
		const review = await prepareInstall(t.db, t.owner, 'prj', { files });
		const key: ActorContext = {
			...t.owner,
			viaSession: false,
			apiKeyId: 'key_1',
			apiKeyName: 'cli'
		};
		await expect(
			installPack(t.db, t.env, key, 'prj', { files, expected_digest: review.digest })
		).rejects.toMatchObject({ code: 'browser_required' });
	});

	it('marks missing values, refuses dispatch on them, and clears once set', async () => {
		const t = fixture();
		const files = wire(engineeringPack());
		const review = await prepareInstall(t.db, t.owner, 'prj', { files });
		const receipt = await installPack(t.db, t.env, t.owner, 'prj', {
			files,
			expected_digest: review.digest
		});
		expect(receipt.pack.needs_setup.map((m) => m.input).sort()).toEqual([
			'app_repo',
			'escalation',
			'github_token'
		]);
		const detail = await getPack(t.db, t.owner, 'prj', receipt.pack.id);
		const eng = detail.workflows.find((w) => w.key === 'engineering')!;
		const issue = await issueIn(t, eng.id, 'Implement');
		const ctx = await effectiveContextForIssue(t.db, 'owner', issue.id);
		expect(ctx.missing_inputs?.map((m) => m.input).sort()).toEqual([
			'app_repo',
			'escalation',
			'github_token'
		]);
		expect((await loadEligibleIssues(t.db, 'owner')).map((i) => i.id)).not.toContain(issue.id);

		await setPackValues(t.db, t.env, t.owner, 'prj', receipt.pack.id, {
			values: {
				app_repo: { repo_url: 'https://github.com/acme/app' },
				escalation: { workflow_id: eng.id }
			}
		});
		expect((await loadEligibleIssues(t.db, 'owner')).map((i) => i.id)).not.toContain(issue.id);
		await setMySecrets(t.db, t.env, t.owner, 'prj', receipt.pack.id, {
			secrets: { github_token: 'x' }
		});
		expect((await loadEligibleIssues(t.db, 'owner')).map((i) => i.id)).toContain(issue.id);
		const packs = await listProjectPacks(t.db, 'prj', 'owner');
		expect(packs[0].needs_setup).toEqual([]);
	});

	it('keeps installed packs read-only and their workflows in their project', async () => {
		const t = fixture();
		const receipt = await install(t);
		const detail = await getPack(t.db, t.owner, 'prj', receipt.pack.id);
		const eng = detail.workflows.find((w) => w.key === 'engineering')!;
		const item = detail.items.find((i) => i.name === 'conventions')!;
		expect(item.pack).toMatchObject({ kind: 'installed', reach: 'project' });
		await expect(
			updateContextItem(t.db, t.env, t.owner, item.id, { body: 'x' })
		).rejects.toMatchObject({
			code: 'pack_read_only'
		});
		await expect(
			updateWorkflow(t.db, t.env, t.owner, t.effects, eng.id, { name: 'x' })
		).rejects.toMatchObject({
			code: 'pack_read_only'
		});
		await expect(
			createIssue(t.db, t.env, t.owner, t.effects, 'prj2', {
				title: 'x',
				workflow_id: eng.id
			} as never)
		).rejects.toMatchObject({ code: 'workflow_not_in_project' });
	});

	it('creates checked suggested schedules, rendered once, enabled', async () => {
		const t = fixture();
		const receipt = await install(t, engineeringPack(), {
			schedules: [{ key: 'weekly-triage', timezone: 'Europe/London' }]
		});
		expect(receipt.schedules_created).toHaveLength(1);
		const row = t.sqlite.prepare('SELECT * FROM scheduled_task').get() as Record<string, unknown>;
		expect(row).toMatchObject({
			enabled: 1,
			timezone: 'Europe/London',
			title_template: 'Triage for {{ date }}'
		});
		expect(String(row.description_template)).toContain(
			'the "Engineering" workflow, starting in "Human review"'
		);
		expect(row.pack_schedule_id).toBeTruthy();
	});
});

describe('packs: replace', () => {
	function v5(): Record<string, string> {
		const p = engineeringPack();
		return {
			...p,
			'pack.yaml': p['pack.yaml'].replace('version: 4', 'version: 5'),
			'CHANGELOG.md': '## 5\n\n- Dropped review.\n\n## 4\n\n- Added QA.\n',
			'migrations.yaml': `"5":
  removed:
    engineering/review: engineering/implement
`,
			'workflows/engineering/workflow.yaml': p['workflows/engineering/workflow.yaml']
				.replace(
					/  review:\n    name: Human review\n    category: awaiting_human\n    transitions:\n      Request changes: implement\n      Approve: done\n/,
					''
				)
				.replace('Ready for review: { to: review, requires: [pull-request] }', 'Ship: done'),
			'workflows/engineering/states/review/instructions.md': undefined as unknown as string,
			'workflows/engineering/states/implement/instructions.md': 'Implement it, v5.\n'
		};
	}
	const clean = (r: Record<string, string>) =>
		Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));

	it('replaces in place: ids survive, removed states map their issues and additions, values stay', async () => {
		const t = fixture();
		const receipt = await install(t);
		const before = await getPack(t.db, t.owner, 'prj', receipt.pack.id);
		const eng = before.workflows.find((w) => w.key === 'engineering')!;
		const review = eng.states.find((s) => s.key === 'review')!;
		const implement = eng.states.find((s) => s.key === 'implement')!;
		const issue = await issueIn(t, eng.id, 'Human review');
		// A project addition on the review state (a journal) moves with the mapping.
		t.sqlite
			.prepare(
				`INSERT INTO context_item (id,user_id,kind,name,description,project_id,workflow_state_id,body,position,version,created_at,updated_at)
				VALUES ('ctx_j','owner','prompt','journal','','prj',?,'learned',0,1,0,0)`
			)
			.run(review.id);

		const files = wire(clean(v5()));
		const prep = await prepareReplace(t.db, t.owner, 'prj', receipt.pack.id, { files });
		expect(prep.errors).toEqual([]);
		expect(prep.changelog).toBe('## 5\n\n- Dropped review.');
		expect(prep.state_mapping).toEqual([
			expect.objectContaining({
				state_id: review.id,
				issues: 1,
				additions: 1,
				suggested: 'engineering/implement'
			})
		]);
		expect(prep.files?.map((f) => `${f.change}:${f.path}`)).toEqual(
			expect.arrayContaining([
				'changed:CHANGELOG.md',
				'removed:workflows/engineering/states/review/instructions.md'
			])
		);
		const out = await replacePack(t.db, t.env, t.owner, 'prj', receipt.pack.id, {
			files,
			expected_digest: prep.digest
		});
		expect(out.issues_moved).toBe(1);
		const after = await getPack(t.db, t.owner, 'prj', receipt.pack.id);
		expect(after.version).toBe(5);
		const eng2 = after.workflows.find((w) => w.key === 'engineering')!;
		expect(eng2.id).toBe(eng.id);
		expect(eng2.states.find((s) => s.key === 'implement')!.id).toBe(implement.id);
		expect(eng2.states.map((s) => s.key)).toEqual(['triage', 'implement', 'done']);
		const moved = t.sqlite.prepare('SELECT state_id FROM issue WHERE id = ?').get(issue.id) as {
			state_id: string;
		};
		expect(moved.state_id).toBe(implement.id);
		const journal = t.sqlite
			.prepare("SELECT workflow_state_id FROM context_item WHERE id = 'ctx_j'")
			.get() as {
			workflow_state_id: string;
		};
		expect(journal.workflow_state_id).toBe(implement.id);
		expect(after.needs_setup).toEqual([]);
		const ctx = await effectiveContextForIssue(t.db, 'owner', issue.id);
		expect(ctx.prompt.text).toContain('Implement it, v5.');
	});

	it('refuses a different pack id and asks before going back a version', async () => {
		const t = fixture();
		const receipt = await install(t);
		const other = wire({
			...engineeringPack(),
			'pack.yaml': engineeringPack()['pack.yaml'].replace('tbuckley/engineering', 'x/other')
		});
		const prep = await prepareReplace(t.db, t.owner, 'prj', receipt.pack.id, { files: other });
		expect(prep.errors.map((e) => e.code)).toContain('different_pack');
		const older = wire({
			...engineeringPack(),
			'pack.yaml': engineeringPack()['pack.yaml'].replace('version: 4', 'version: 3')
		});
		const prep2 = await prepareReplace(t.db, t.owner, 'prj', receipt.pack.id, { files: older });
		expect(prep2.version_warning).toBe('lower_version');
		await expect(
			replacePack(t.db, t.env, t.owner, 'prj', receipt.pack.id, {
				files: older,
				expected_digest: prep2.digest
			})
		).rejects.toMatchObject({ code: 'version_confirmation_required' });
	});
});

describe('packs: authored', () => {
	it('authors a pack from a copied workflow, exports versions, and round-trips through install', async () => {
		const t = fixture();
		const pack = await createPack(t.db, t.env, t.owner, 'prj', { name: 'Ops' });
		expect(pack.kind).toBe('authored');
		expect(pack.version).toBeNull();
		const withWf = await addPackWorkflow(t.db, t.env, t.owner, 'prj', pack.id, {
			copy_from: 'wf_standard'
		});
		expect(withWf.workflows).toHaveLength(1);
		await updatePack(t.db, t.env, t.owner, 'prj', pack.id, {
			inputs: { team: { type: 'text', description: 'Team name' } }
		});
		await createPackItem(t.db, t.env, t.owner, 'prj', pack.id, {
			reach: 'project',
			kind: 'prompt',
			name: 'team',
			body: 'You work for {{ inputs.team }}.'
		});
		await expect(
			createPackItem(t.db, t.env, t.owner, 'prj', pack.id, {
				reach: 'project',
				kind: 'prompt',
				name: 'bad',
				body: '{{ inputs.nope }}'
			})
		).rejects.toMatchObject({ code: 'invalid_pack' });

		const first = await exportPack(t.db, t.env, t.owner, 'prj', pack.id);
		expect(first.version).toBe(1);
		expect(first.new_version).toBe(true);
		const again = await exportPack(t.db, t.env, t.owner, 'prj', pack.id);
		expect(again).toMatchObject({ version: 1, digest: first.digest, new_version: false });

		// Install the export into another project.
		const review = await prepareInstall(t.db, t.owner, 'prj2', { files: first.files });
		expect(review.errors).toEqual([]);
		expect(review.digest).toBe(first.digest);
		const installed = await installPack(t.db, t.env, t.owner, 'prj2', {
			files: first.files,
			expected_digest: review.digest,
			values: { team: { text: 'Core' } }
		});
		expect(installed.pack).toMatchObject({ kind: 'installed', version: 1, digest: first.digest });

		// An edit takes the next version on export.
		const item = (await getPack(t.db, t.owner, 'prj', pack.id)).items.find(
			(i) => i.name === 'team'
		)!;
		await updateContextItem(t.db, t.env, t.owner, item.id, {
			body: 'You work for {{ inputs.team }}!'
		});
		const second = await exportPack(t.db, t.env, t.owner, 'prj', pack.id);
		expect(second.version).toBe(2);
		// The installed copy re-exports unchanged.
		const reexport = await exportPack(t.db, t.env, t.owner, 'prj2', installed.pack.id);
		expect(reexport.digest).toBe(first.digest);
		expect((await listProjectPacks(t.db, 'prj', 'owner'))[0].changed_since_export).toBe(false);
	});

	it('detaches an installed pack and removes a pack once nothing uses it', async () => {
		const t = fixture();
		const receipt = await install(t);
		const detached = await detachPack(t.db, t.env, t.owner, 'prj', receipt.pack.id, {});
		expect(detached).toMatchObject({
			kind: 'authored',
			version: null,
			derived_from: { id: 'tbuckley/engineering', version: 4 }
		});
		expect(detached.pack_key).not.toBe('tbuckley/engineering');
		const eng = detached.workflows.find((w) => w.key === 'engineering')!;
		await issueIn(t, eng.id);
		const preview = await removePreview(t.db, t.owner, 'prj', receipt.pack.id);
		expect(preview.blocked_by.issues).toHaveLength(1);
		await expect(
			removePack(t.db, t.env, t.owner, 'prj', receipt.pack.id, {})
		).rejects.toMatchObject({ code: 'pack_in_use' });
		t.sqlite.prepare('DELETE FROM issue_address').run();
		t.sqlite.prepare('DELETE FROM issue').run();
		await removePack(t.db, t.env, t.owner, 'prj', receipt.pack.id, {});
		expect(await listProjectPacks(t.db, 'prj', 'owner')).toEqual([]);
		expect(
			t.sqlite.prepare('SELECT COUNT(*) AS n FROM context_item WHERE project_id = ?').get('prj')
		).toEqual({ n: 0 });
		expect(
			t.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow WHERE pack_id IS NOT NULL').get()
		).toEqual({ n: 0 });
	});
});
