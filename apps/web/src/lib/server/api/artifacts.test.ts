import {
	ARTIFACT_FILE_MAX_BYTES,
	ARTIFACT_TEXT_MAX_BYTES,
	type Artifact,
	type IssueDetail
} from '@tines/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getArtifactStore } from '$lib/server/artifact-store';
import { PROJECT, USER, seedBase } from '../supervisor/test-fixtures';
import {
	artifactContentResponse,
	checkRequirements,
	deleteArtifact,
	getArtifactDetail,
	listArtifacts,
	reaffirmArtifact,
	upsertArtifact,
	uploadArtifactFile,
	uploadArtifactFolder
} from './artifacts';
import {
	buildLaunchPrompt,
	createContextItem,
	deleteContextItem,
	effectiveContextForIssue,
	issueBlock,
	listContextItems,
	updateContextItem
} from './context';
import { ApiFail, type ActorContext } from './core';
import { createIssue, getIssueDetail, transitionIssue, updateIssue } from './issues';
import { createWorkflow, loadWorkflow, updateWorkflow } from './workflows';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

/** The motivating workflow: design → implementation gated on a design doc. */
const GATED_WORKFLOW = {
	name: 'Design loop',
	initial_state: 'Design',
	states: [
		{ name: 'Design', category: 'active' as const },
		{ name: 'Implementation', category: 'active' as const },
		{ name: 'Done', category: 'done' as const }
	],
	transitions: [
		{
			name: 'approve',
			from: 'Design',
			to: 'Implementation',
			requires: [
				{
					artifact: 'design-doc',
					type: 'text' as const,
					content_type: 'text/markdown',
					description: 'The approved design document for this round'
				}
			]
		},
		{ name: 'send back', from: 'Implementation', to: 'Design' },
		{ name: 'ship', from: 'Implementation', to: 'Done' }
	]
};

describe('issue artifacts', () => {
	let t: TestDb;
	let clock: number;

	beforeEach(() => {
		t = createTestDb();
		seedBase(t);
		clock = 1_723_000_100_000;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const tick = (ms = 1000) => (clock += ms);

	async function gatedIssue(): Promise<IssueDetail> {
		const wf = await createWorkflow(t.db, t.env, actor, GATED_WORKFLOW);
		return createIssue(t.db, t.env, actor, PROJECT, { title: 'Ship it', workflow_id: wf.id });
	}

	const attachDoc = (issueId: string, content = '# Design') =>
		upsertArtifact(t.db, t.env, actor, issueId, 'design-doc', { type: 'text', content });

	// -------------------------------------------------------------------------
	// Workflow requirements: definition round-trip and validation

	it('round-trips transition requirements through create and load', async () => {
		const wf = await createWorkflow(t.db, t.env, actor, GATED_WORKFLOW);
		const loaded = await loadWorkflow(t.db, USER, wf.id);
		const approve = loaded.transitions.find((tr) => tr.name === 'approve')!;
		expect(approve.requires).toEqual([
			{
				artifact: 'design-doc',
				type: 'text',
				content_type: 'text/markdown',
				description: 'The approved design document for this round'
			}
		]);
		expect(loaded.transitions.find((tr) => tr.name === 'send back')!.requires).toBeUndefined();

		// A PATCH that doesn't resend transitions still re-creates the rows
		// wholesale — the requirements must survive the round-trip.
		const patched = await updateWorkflow(t.db, t.env, actor, wf.id, { description: 'gated' });
		expect(patched.transitions.find((tr) => tr.name === 'approve')!.requires).toHaveLength(1);
	});

	it('rejects invalid requirement definitions with 422s', async () => {
		const base = {
			name: 'Bad',
			initial_state: 'A',
			states: [
				{ name: 'A', category: 'active' as const },
				{ name: 'B', category: 'done' as const }
			]
		};
		const attempt = (requires: unknown) =>
			createWorkflow(t.db, t.env, actor, {
				...base,
				transitions: [{ name: 'go', from: 'A', to: 'B', requires } as never]
			});
		await expect(attempt([{ artifact: 'Not A Slug' }])).rejects.toMatchObject({ status: 422 });
		await expect(attempt([{ artifact: 'x', type: 'zip' }])).rejects.toMatchObject({
			code: 'unknown_artifact_type'
		});
		// content_type is only meaningful with a declared file/text type —
		// folder included: mixed trees admit no honest match rule.
		await expect(
			attempt([{ artifact: 'x', type: 'pr', content_type: 'text/' }])
		).rejects.toMatchObject({
			status: 422
		});
		await expect(
			attempt([{ artifact: 'x', type: 'folder', content_type: 'image/' }])
		).rejects.toMatchObject({ status: 422 });
		await expect(attempt([{ artifact: 'x', content_type: 'text/' }])).rejects.toMatchObject({
			status: 422
		});
		await expect(attempt([{ artifact: 'x' }, { artifact: 'x' }])).rejects.toMatchObject({
			code: 'duplicate_requirement'
		});
	});

	// -------------------------------------------------------------------------
	// The motivating loop: gate → attach → pass → send back → stale → reaffirm

	it('walks the design → implementation loop end to end', async () => {
		const issue = await gatedIssue();

		// 1. Blocked while the slot is empty, with self-correction details.
		let error: ApiFail | undefined;
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'approve' }).catch(
			(e) => (error = e)
		);
		expect(error).toMatchObject({ status: 422, code: 'transition_requirements_unmet' });
		expect(error!.message).toContain('design-doc');
		const unmet = error!.details!.unmet as Record<string, unknown>[];
		expect(unmet[0]).toMatchObject({
			artifact: 'design-doc',
			status: 'missing',
			current_version: null
		});
		expect(unmet[0].fix).toContain('tines issues artifacts attach demo/1 design-doc');
		expect(error!.details!.state_entered_at).toBe(issue.state_entered_at);

		// Pre-flight visibility on the issue read.
		const before = await getIssueDetail(t.db, USER, { id: issue.id });
		const approve = before.allowed_transitions.find((tr) => tr.name === 'approve')!;
		expect(approve.requires![0]).toMatchObject({ artifact: 'design-doc', status: 'missing' });

		// 2. Attaching the doc satisfies the gate.
		tick();
		await attachDoc(issue.id);
		const moved = await transitionIssue(t.db, t.env, actor, issue.id, { action: 'approve' });
		expect(moved.state.name).toBe('Implementation');
		expect(moved.state_entered_at).toBe(clock);

		// 3. Sending back makes the old doc stale (freshness is derived, not
		// mutated: nothing touched the artifact rows).
		tick();
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'send back' });
		const [stale] = await listArtifacts(t.db, USER, issue.id);
		expect(stale.fresh).toBe(false);
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'approve' }).catch(
			(e) => (error = e)
		);
		expect((error!.details!.unmet as Record<string, unknown>[])[0]).toMatchObject({
			status: 'stale',
			current_version: { version: 1 }
		});

		// 4. A new version (v2) unblocks; both versions stay inspectable.
		tick();
		await attachDoc(issue.id, '# Design v2');
		const detail = await getArtifactDetail(t.db, USER, issue.id, 'design-doc');
		expect(detail.versions.map((v) => v.version)).toEqual([1, 2]);
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'approve' });

		// 5. Back once more; reaffirming blesses v2's content as v3.
		tick();
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'send back' });
		tick();
		const reaffirmed = await reaffirmArtifact(t.db, t.env, actor, issue.id, 'design-doc');
		expect(reaffirmed.current_version).toMatchObject({ version: 3, reaffirmed_from: 2 });
		expect(reaffirmed.fresh).toBe(true);
		const after = await transitionIssue(t.db, t.env, actor, issue.id, { action: 'approve' });
		expect(after.state.name).toBe('Implementation');

		// v3 served v2's exact content.
		const res = await artifactContentResponse(t.db, t.env, USER, issue.id, 'design-doc');
		expect(await res.text()).toBe('# Design v2');
	});

	it('checks type and content-type when the requirement narrows them', async () => {
		const artifacts: Pick<Artifact, 'name' | 'artifact_type' | 'fresh' | 'current_version'>[] = [
			{
				name: 'shot',
				artifact_type: 'file',
				fresh: true,
				current_version: {
					version: 1,
					content_type: 'image/png',
					created_at: 5
				} as Artifact['current_version']
			}
		];
		expect(
			checkRequirements([{ artifact: 'shot', content_type: 'image/' }], artifacts)[0]
		).toMatchObject({
			status: 'satisfied',
			current_type: 'file'
		});
		expect(checkRequirements([{ artifact: 'shot', type: 'pr' }], artifacts)[0].status).toBe(
			'type_mismatch'
		);
		expect(
			checkRequirements([{ artifact: 'shot', content_type: 'text/markdown' }], artifacts)[0].status
		).toBe('type_mismatch');
		expect(checkRequirements([{ artifact: 'other' }], artifacts)[0]).toMatchObject({
			status: 'missing',
			current_type: null
		});
	});

	it('emits fix commands that respect the existing artifact type (which is immutable)', async () => {
		const wf = await createWorkflow(t.db, t.env, actor, {
			name: 'Fix commands',
			initial_state: 'A',
			states: [
				{ name: 'A', category: 'active' },
				{ name: 'B', category: 'active' }
			],
			transitions: [
				{
					name: 'go',
					from: 'A',
					to: 'B',
					requires: [
						{ artifact: 'notes' },
						{ artifact: 'spec', type: 'text' },
						{ artifact: 'shot', type: 'file', content_type: 'image/' }
					]
				}
			]
		});
		const issue = await createIssue(t.db, t.env, actor, PROJECT, {
			title: 'Fixes',
			workflow_id: wf.id
		});

		// notes: attached as text, then made stale by re-entering the state.
		await upsertArtifact(t.db, t.env, actor, issue.id, 'notes', { type: 'text', content: 'n' });
		tick();
		await updateIssue(t.db, t.env, actor, issue.id, { state: 'B' });
		tick();
		await updateIssue(t.db, t.env, actor, issue.id, { state: 'A' });
		// spec: the slot holds a link — the wrong immutable type for the text requirement.
		tick();
		await upsertArtifact(t.db, t.env, actor, issue.id, 'spec', {
			type: 'link',
			url: 'https://x.test/spec'
		});
		// shot: the right type (file), the wrong content type.
		await uploadArtifactFile(t.db, t.env, actor, issue.id, 'shot', {
			filename: 'shot.txt',
			contentType: 'text/plain',
			bytes: enc('not an image')
		});

		let error: ApiFail | undefined;
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'go' }).catch((e) => (error = e));
		expect(error).toMatchObject({ status: 422, code: 'transition_requirements_unmet' });
		const unmet = new Map(
			(error!.details!.unmet as (Record<string, unknown> & { artifact: string })[]).map((r) => [
				r.artifact,
				r
			])
		);

		// Stale over an untyped requirement: a new version keeps the slot's own
		// type (--text, not the file default), or the reaffirm alternative.
		expect(unmet.get('notes')).toMatchObject({ status: 'stale', current_type: 'text' });
		expect(unmet.get('notes')!.fix).toContain('attach demo/1 notes --text');
		expect(unmet.get('notes')!.fix).toContain('reaffirm demo/1 notes');

		// Wrong immutable type: a same-name attach would 422, so the fix
		// deletes the slot before re-attaching the required type.
		expect(unmet.get('spec')).toMatchObject({ status: 'type_mismatch', current_type: 'link' });
		expect(unmet.get('spec')!.fix).toContain('delete demo/1 spec && ');
		expect(unmet.get('spec')!.fix).toContain('attach demo/1 spec --text');

		// content_type-only miss on the right type: a plain re-attach suffices.
		expect(unmet.get('shot')).toMatchObject({ status: 'type_mismatch', current_type: 'file' });
		expect(unmet.get('shot')!.fix).toContain('attach demo/1 shot --file');
		expect(unmet.get('shot')!.fix).not.toContain('delete');
	});

	it('counts an artifact attached before the gating state as stale, per the strict rule', async () => {
		const issue = await gatedIssue();
		await attachDoc(issue.id);
		// Force elsewhere and back: state_entered_at advances past the attach.
		tick();
		await updateIssue(t.db, t.env, actor, issue.id, { state: 'Implementation' });
		tick();
		await updateIssue(t.db, t.env, actor, issue.id, { state: 'Design' });
		const detail = await getIssueDetail(t.db, USER, { id: issue.id });
		expect(detail.state_entered_at).toBe(clock);
		expect(
			detail.allowed_transitions.find((tr) => tr.name === 'approve')!.requires![0].status
		).toBe('stale');
	});

	// -------------------------------------------------------------------------
	// The escape hatch and the run-key fence

	it('lets a human force-set the state past a gate, but 403s a run key', async () => {
		const issue = await gatedIssue();
		const forced = await updateIssue(t.db, t.env, actor, issue.id, { state: 'Implementation' });
		expect(forced.state.name).toBe('Implementation');

		// agentRunId alone marks the run key; no api_key row is needed for the
		// fence (the guard never reaches a write).
		const runActor: ActorContext = { ...actor, agentRunId: 'arun_1' };
		await expect(
			updateIssue(t.db, t.env, runActor, issue.id, { state: 'Design' })
		).rejects.toMatchObject({ status: 403, code: 'run_key_forbidden' });
		await expect(
			updateIssue(t.db, t.env, runActor, issue.id, { workflow_id: 'wf_standard' })
		).rejects.toMatchObject({ status: 403 });
		// Non-fenced fields stay run-key-legal.
		const titled = await updateIssue(t.db, t.env, runActor, issue.id, { title: 'Renamed' });
		expect(titled.title).toBe('Renamed');
	});

	// -------------------------------------------------------------------------
	// Upserts, versions, payload validation

	it('upserts per type, validates payloads, and enforces caps', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Plain' });

		// Type is immutable per slot.
		await attachDoc(issue.id);
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'design-doc', {
				type: 'link',
				url: 'https://x.test'
			})
		).rejects.toMatchObject({ code: 'artifact_type_mismatch' });
		// Foreign payload fields are rejected, not dropped.
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'design-doc', { url: 'https://x.test' })
		).rejects.toMatchObject({ code: 'artifact_payload_mismatch' });

		// Metadata-only upsert: description changes, no new version.
		const meta = await upsertArtifact(t.db, t.env, actor, issue.id, 'design-doc', {
			description: 'The doc'
		});
		expect(meta).toMatchObject({ description: 'The doc', version_count: 1 });

		// link + pr payloads (pr from a full URL and from split fields).
		const link = await upsertArtifact(t.db, t.env, actor, issue.id, 'thread', {
			type: 'link',
			url: 'https://example.com/review',
			title: 'Review thread'
		});
		expect(link.current_version).toMatchObject({
			url: 'https://example.com/review',
			title: 'Review thread'
		});
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'bad-link', { type: 'link', url: 'ftp://x' })
		).rejects.toMatchObject({ status: 422 });
		const pr = await upsertArtifact(t.db, t.env, actor, issue.id, 'impl-pr', {
			type: 'pr',
			pr_url: 'https://github.com/acme/app/pull/123'
		});
		expect(pr.current_version).toMatchObject({
			pr_repo_url: 'https://github.com/acme/app',
			pr_number: 123
		});
		const pr2 = await upsertArtifact(t.db, t.env, actor, issue.id, 'impl-pr', {
			pr_repo_url: 'git@github.com:acme/app.git',
			pr_number: 124
		});
		expect(pr2.current_version).toMatchObject({
			pr_repo_url: 'https://github.com/acme/app',
			pr_number: 124,
			version: 2
		});

		// Names are slugs; text has a byte cap naming the limit.
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'Not Valid', { type: 'text', content: 'x' })
		).rejects.toMatchObject({ status: 422 });
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'big', {
				type: 'text',
				content: 'x'.repeat(ARTIFACT_TEXT_MAX_BYTES + 1)
			})
		).rejects.toMatchObject({ code: 'artifact_too_large' });

		// File payloads never ride the JSON upsert.
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'shot', { type: 'file' })
		).rejects.toMatchObject({ code: 'use_file_endpoint' });
	});

	it('stores file uploads in the artifact store and reuses objects on reaffirm', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Files' });
		const bytes = new TextEncoder().encode('PNGDATA');
		const uploaded = await uploadArtifactFile(t.db, t.env, actor, issue.id, 'feature-screenshot', {
			filename: 'shot.png',
			contentType: 'image/png',
			bytes
		});
		expect(uploaded.current_version).toMatchObject({
			filename: 'shot.png',
			content_type: 'image/png',
			size_bytes: bytes.byteLength
		});

		// Reaffirm copies the payload without a new object: both versions
		// reference one stored key.
		tick();
		await reaffirmArtifact(t.db, t.env, actor, issue.id, 'feature-screenshot');
		const keys = t
			.all(
				`SELECT r2_key FROM artifact_version av
			 JOIN context_item ci ON ci.id = av.context_item_id WHERE ci.name = 'feature-screenshot'`
			)
			.map((r) => r.r2_key);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(1);
		const stored = await getArtifactStore(t.env).get(keys[0] as string);
		expect(new TextDecoder().decode(stored!)).toBe('PNGDATA');

		// The cap is enforced on the actual bytes.
		await expect(
			uploadArtifactFile(t.db, t.env, actor, issue.id, 'huge', {
				filename: 'huge.bin',
				contentType: 'application/octet-stream',
				bytes: new Uint8Array(ARTIFACT_FILE_MAX_BYTES + 1)
			})
		).rejects.toMatchObject({ code: 'artifact_too_large' });

		// Deleting the artifact removes its rows and its stored objects.
		await deleteArtifact(t.db, t.env, actor, issue.id, 'feature-screenshot');
		expect(await getArtifactStore(t.env).get(keys[0] as string)).toBeNull();
		expect(await listArtifacts(t.db, USER, issue.id)).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Folder artifacts: snapshot uploads, per-path serving, generic gating

	const enc = (s: string) => new TextEncoder().encode(s);

	it('uploads a mixed tree as one snapshot and serves it per path', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Shots' });
		const uploaded = await uploadArtifactFolder(t.db, t.env, actor, issue.id, 'screenshots', [
			{ path: 'login.png', contentType: 'image/png', bytes: enc('PNG1') },
			{ path: 'settings/billing.png', contentType: 'image/png', bytes: enc('PNG2') },
			{ path: 'notes.md', contentType: 'text/markdown', bytes: enc('# notes') }
		]);
		expect(uploaded).toMatchObject({
			artifact_type: 'folder',
			fresh: true,
			current_version: { version: 1, file_count: 3, size_bytes: 15 }
		});

		// Detail carries the file list (metadata only), sorted by path.
		const detail = await getArtifactDetail(t.db, USER, issue.id, 'screenshots');
		expect(detail.current_version.files!.map((f) => f.path)).toEqual([
			'login.png',
			'notes.md',
			'settings/billing.png'
		]);

		// Per-path serving under the safety headers; no path → 422 listing them.
		const png = await artifactContentResponse(t.db, t.env, USER, issue.id, 'screenshots', {
			path: 'settings/billing.png',
			inline: true
		});
		expect(await png.text()).toBe('PNG2');
		expect(png.headers.get('content-type')).toBe('image/png');
		expect(png.headers.get('content-disposition')).toBe('inline; filename="billing.png"');
		expect(png.headers.get('content-security-policy')).toBe('sandbox');
		let noPath: ApiFail | undefined;
		await artifactContentResponse(t.db, t.env, USER, issue.id, 'screenshots').catch(
			(e) => (noPath = e)
		);
		expect(noPath).toMatchObject({ code: 'folder_path_required' });
		expect(noPath!.details!.paths).toEqual(['login.png', 'notes.md', 'settings/billing.png']);
		await expect(
			artifactContentResponse(t.db, t.env, USER, issue.id, 'screenshots', { path: 'missing.png' })
		).rejects.toMatchObject({ status: 404 });

		// A new snapshot replaces the set wholesale (v2); v1 stays fetchable.
		tick();
		const v2 = await uploadArtifactFolder(t.db, t.env, actor, issue.id, 'screenshots', [
			{ path: 'login.png', contentType: 'image/png', bytes: enc('PNG1b') }
		]);
		expect(v2.current_version).toMatchObject({ version: 2, file_count: 1 });
		const old = await artifactContentResponse(t.db, t.env, USER, issue.id, 'screenshots', {
			version: 1,
			path: 'notes.md'
		});
		expect(await old.text()).toBe('# notes');

		// Reaffirm copies the file rows, reusing the same stored objects.
		tick();
		const reaffirmed = await reaffirmArtifact(t.db, t.env, actor, issue.id, 'screenshots');
		expect(reaffirmed.current_version).toMatchObject({
			version: 3,
			file_count: 1,
			reaffirmed_from: 2
		});
		const keys = t
			.all(
				`SELECT avf.r2_key FROM artifact_version_file avf
			 JOIN artifact_version av ON av.id = avf.artifact_version_id
			 WHERE av.version IN (2, 3) ORDER BY av.version`
			)
			.map((r) => r.r2_key);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);

		// The JSON upsert refuses folder payload writes, pointing at the endpoint.
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'screenshots', { content: 'x' })
		).rejects.toMatchObject({ code: 'use_folder_endpoint' });
		await expect(
			upsertArtifact(t.db, t.env, actor, issue.id, 'other', { type: 'folder' })
		).rejects.toMatchObject({ code: 'use_folder_endpoint' });

		// Delete removes file rows and stored objects.
		await deleteArtifact(t.db, t.env, actor, issue.id, 'screenshots');
		expect(t.all('SELECT * FROM artifact_version_file')).toEqual([]);
		expect(await getArtifactStore(t.env).get(keys[0] as string)).toBeNull();
	});

	it('validates folder snapshots: paths, duplicates, and caps', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Bad folders' });
		const upload = (files: { path: string; contentType: string; bytes: Uint8Array }[]) =>
			uploadArtifactFolder(t.db, t.env, actor, issue.id, 'bundle', files);
		await expect(upload([])).rejects.toMatchObject({ status: 422 });
		await expect(
			upload([{ path: '../escape.png', contentType: 'image/png', bytes: enc('x') }])
		).rejects.toMatchObject({ code: 'invalid_path' });
		await expect(
			upload([
				{ path: 'a.png', contentType: 'image/png', bytes: enc('x') },
				{ path: 'a.png', contentType: 'image/png', bytes: enc('y') }
			])
		).rejects.toMatchObject({ code: 'duplicate_path' });
		const many = Array.from({ length: 201 }, (_, i) => ({
			path: `f${i}.txt`,
			contentType: 'text/plain',
			bytes: enc('x')
		}));
		await expect(upload(many)).rejects.toMatchObject({ code: 'artifact_too_large' });

		// Type immutability holds across the endpoints.
		await uploadArtifactFile(t.db, t.env, actor, issue.id, 'single', {
			filename: 'a.png',
			contentType: 'image/png',
			bytes: enc('x')
		});
		await expect(
			uploadArtifactFolder(t.db, t.env, actor, issue.id, 'single', [
				{ path: 'a.png', contentType: 'image/png', bytes: enc('x') }
			])
		).rejects.toMatchObject({ code: 'artifact_type_mismatch' });
	});

	it('satisfies a generic folder requirement regardless of the set contents', async () => {
		const wf = await createWorkflow(t.db, t.env, actor, {
			name: 'Generic UI loop',
			initial_state: 'Build',
			states: [
				{ name: 'Build', category: 'active' },
				{ name: 'Review', category: 'awaiting_human' }
			],
			transitions: [
				{
					name: 'submit',
					from: 'Build',
					to: 'Review',
					// Generic over all surfaces: the slot is fixed, the contents vary.
					requires: [{ artifact: 'screenshots', type: 'folder' }]
				}
			]
		});
		const issue = await createIssue(t.db, t.env, actor, PROJECT, {
			title: 'Any feature',
			workflow_id: wf.id
		});
		let error: ApiFail | undefined;
		await transitionIssue(t.db, t.env, actor, issue.id, { action: 'submit' }).catch(
			(e) => (error = e)
		);
		expect((error!.details!.unmet as Record<string, unknown>[])[0].fix).toContain('--folder <dir>');

		// A sibling `file` artifact does not satisfy the folder-typed slot…
		tick();
		await uploadArtifactFile(t.db, t.env, actor, issue.id, 'screenshots-extra', {
			filename: 'x.png',
			contentType: 'image/png',
			bytes: enc('x')
		});
		await expect(
			transitionIssue(t.db, t.env, actor, issue.id, { action: 'submit' })
		).rejects.toMatchObject({ code: 'transition_requirements_unmet' });

		// …but any folder snapshot under the slot name does.
		tick();
		await uploadArtifactFolder(t.db, t.env, actor, issue.id, 'screenshots', [
			{ path: 'whatever-this-feature-has.png', contentType: 'image/png', bytes: enc('x') }
		]);
		const moved = await transitionIssue(t.db, t.env, actor, issue.id, { action: 'submit' });
		expect(moved.state.name).toBe('Review');
	});

	// -------------------------------------------------------------------------
	// Write races and read scale

	it('retries a lost version-slot race instead of surfacing the raw constraint error', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Race' });
		await attachDoc(issue.id, '# v1');

		// Simulate a concurrent attach winning `version = last + 1`: just before
		// this write's batch lands, a rival row takes version 2, so the batch
		// hits UNIQUE(context_item_id, version) and the retry re-reads to v3.
		const itemId = t.all(`SELECT id FROM context_item WHERE name = 'design-doc'`)[0].id as string;
		const originalBatch = t.env.DB.batch.bind(t.env.DB);
		let injected = false;
		(t.env.DB as { batch: typeof originalBatch }).batch = async (statements) => {
			if (!injected) {
				injected = true;
				t.sqlite
					.prepare(
						`INSERT INTO artifact_version (id, context_item_id, version, content, created_at)
						 VALUES ('av_rival', ?, 2, '# rival', ?)`
					)
					.run(itemId, Date.now());
			}
			return originalBatch(statements);
		};

		tick();
		const updated = await attachDoc(issue.id, '# v2');
		expect(updated.current_version).toMatchObject({ version: 3 });
		expect(updated.version_count).toBe(3);
		const detail = await getArtifactDetail(t.db, USER, issue.id, 'design-doc');
		expect(detail.versions.map((v) => v.version)).toEqual([1, 2, 3]);
	});

	it('loads artifact lists past the per-query bound-parameter chunk size intact', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Many' });
		// 95 artifacts (> one 90-id chunk), a couple with a second version so
		// per-item ordering across the reassembled chunks is observable.
		for (let i = 0; i < 95; i++) {
			tick(1); // distinct created_at per item — the list orders by it
			await upsertArtifact(t.db, t.env, actor, issue.id, `slot-${String(i).padStart(2, '0')}`, {
				type: 'text',
				content: `v1 of ${i}`
			});
		}
		tick();
		await upsertArtifact(t.db, t.env, actor, issue.id, 'slot-00', { content: 'v2 of 0' });
		await upsertArtifact(t.db, t.env, actor, issue.id, 'slot-94', { content: 'v2 of 94' });

		const artifacts = await listArtifacts(t.db, USER, issue.id);
		expect(artifacts).toHaveLength(95);
		expect(artifacts.map((a) => a.name)).toEqual(
			Array.from({ length: 95 }, (_, i) => `slot-${String(i).padStart(2, '0')}`)
		);
		expect(artifacts[0].current_version).toMatchObject({ version: 2 });
		expect(artifacts[94].current_version).toMatchObject({ version: 2 });
		expect(artifacts[1].current_version).toMatchObject({ version: 1 });
	});

	// -------------------------------------------------------------------------
	// Content serving

	it('serves content attachment-by-default, inline only for the allowlist (sandboxed)', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Serve' });
		await uploadArtifactFile(t.db, t.env, actor, issue.id, 'shot', {
			filename: 'shot.png',
			contentType: 'image/png',
			bytes: new TextEncoder().encode('img')
		});
		const attachment = await artifactContentResponse(t.db, t.env, USER, issue.id, 'shot');
		expect(attachment.headers.get('x-content-type-options')).toBe('nosniff');
		expect(attachment.headers.get('content-disposition')).toBe('attachment; filename="shot.png"');
		expect(attachment.headers.get('content-security-policy')).toBeNull();

		const inline = await artifactContentResponse(t.db, t.env, USER, issue.id, 'shot', {
			inline: true
		});
		expect(inline.headers.get('content-disposition')).toBe('inline; filename="shot.png"');
		expect(inline.headers.get('content-security-policy')).toBe('sandbox');

		// Outside the allowlist, ?inline=1 is ignored.
		await uploadArtifactFile(t.db, t.env, actor, issue.id, 'page', {
			filename: 'page.html',
			contentType: 'text/html',
			bytes: new TextEncoder().encode('<script>alert(1)</script>')
		});
		const html = await artifactContentResponse(t.db, t.env, USER, issue.id, 'page', {
			inline: true
		});
		expect(html.headers.get('content-disposition')).toContain('attachment');

		// References have no content — the reference is the payload.
		await upsertArtifact(t.db, t.env, actor, issue.id, 'impl-pr', {
			type: 'pr',
			pr_url: 'https://github.com/acme/app/pull/9'
		});
		await expect(
			artifactContentResponse(t.db, t.env, USER, issue.id, 'impl-pr')
		).rejects.toMatchObject({ code: 'no_content' });

		// Version history stays fetchable.
		tick();
		await upsertArtifact(t.db, t.env, actor, issue.id, 'doc', { type: 'text', content: 'v1' });
		tick();
		await upsertArtifact(t.db, t.env, actor, issue.id, 'doc', { content: 'v2' });
		const v1 = await artifactContentResponse(t.db, t.env, USER, issue.id, 'doc', { version: 1 });
		expect(await v1.text()).toBe('v1');
	});

	// -------------------------------------------------------------------------
	// Context-system integration

	it('is a context kind with its own creation path and a fenced generic surface', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Ctx' });
		await expect(
			createContextItem(t.db, t.env, actor, { kind: 'artifact', name: 'x', issue_id: issue.id })
		).rejects.toMatchObject({ code: 'use_artifact_endpoints' });

		await attachDoc(issue.id);
		const { items } = await listContextItems(
			t.db,
			USER,
			{ issue: issue.id },
			{ cursor: null, limit: 50 }
		);
		const item = items.find((i) => i.kind === 'artifact')!;
		expect(item).toMatchObject({ name: 'design-doc', artifact_type: 'text' });

		// Rename re-keys requirement matching; scope stays pinned to the issue.
		const renamed = await updateContextItem(t.db, t.env, actor, item.id, { name: 'final-doc' });
		expect(renamed.name).toBe('final-doc');
		expect((await listArtifacts(t.db, USER, issue.id))[0].name).toBe('final-doc');
		await expect(
			updateContextItem(t.db, t.env, actor, item.id, { issue_id: null })
		).rejects.toMatchObject({ code: 'artifact_scope_invalid' });

		// Excluded from the effective context; counted in the summary.
		const context = await effectiveContextForIssue(t.db, USER, issue.id);
		expect(context.prompt.parts).toEqual([]);
		expect(context.skills).toEqual([]);
		const detail = await getIssueDetail(t.db, USER, { id: issue.id });
		expect(detail.context_summary.artifacts).toBe(1);

		// Generic DELETE removes the versions too.
		await deleteContextItem(t.db, t.env, actor, item.id);
		expect(t.all('SELECT * FROM artifact_version')).toEqual([]);
		expect((await getIssueDetail(t.db, USER, { id: issue.id })).context_summary.artifacts).toBe(0);
	});

	it('emits context events with artifact summaries', async () => {
		const issue = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Events' });
		await attachDoc(issue.id);
		tick();
		await attachDoc(issue.id, 'v2');
		tick();
		await reaffirmArtifact(t.db, t.env, actor, issue.id, 'design-doc');
		const events = t
			.all(`SELECT type, payload FROM event WHERE type LIKE 'context.%' ORDER BY created_at, id`)
			.map((e) => ({
				type: e.type,
				payload: JSON.parse(e.payload as string) as Record<string, unknown>
			}));
		expect(events[0]).toMatchObject({
			type: 'context.created',
			payload: { kind: 'artifact', name: 'design-doc', artifact_type: 'text', version: 1 }
		});
		expect(events[1]).toMatchObject({ type: 'context.updated', payload: { version: 2 } });
		expect(events[2]).toMatchObject({
			type: 'context.updated',
			payload: { version: 3, reaffirmed_from: 2 }
		});
	});

	// -------------------------------------------------------------------------
	// Launch prompt

	it('lists artifacts (never contents) and per-transition requirements in the issue block', async () => {
		const issue = await gatedIssue();
		await upsertArtifact(t.db, t.env, actor, issue.id, 'impl-pr', {
			type: 'pr',
			pr_url: 'https://github.com/acme/app/pull/123'
		});
		const [detail, context, artifacts] = [
			await getIssueDetail(t.db, USER, { id: issue.id }),
			await effectiveContextForIssue(t.db, USER, issue.id),
			await listArtifacts(t.db, USER, issue.id)
		];
		const block = issueBlock(detail, context, artifacts);
		expect(block).toContain('### Artifacts');
		expect(block).toContain('- **impl-pr** (pr) — https://github.com/acme/app/pull/123');
		expect(block).toContain(
			'Requires: artifact `design-doc` (text, text/markdown) — **missing; attach it first**'
		);

		tick();
		await attachDoc(issue.id, '# Secret design');
		const [d2, a2] = [
			await getIssueDetail(t.db, USER, { id: issue.id }),
			await listArtifacts(t.db, USER, issue.id)
		];
		const block2 = buildLaunchPrompt(context, d2, a2);
		expect(block2).toContain('- **design-doc** (text, text/markdown, v1, fresh)');
		expect(block2).toContain('Fetch: `tines issues artifacts get demo/');
		expect(block2).toContain('satisfied (v1, fresh)');
		expect(block2).not.toContain('Secret design'); // a listing, never contents

		// Empty case.
		const empty = await createIssue(t.db, t.env, actor, PROJECT, { title: 'Empty' });
		const emptyBlock = issueBlock(
			await getIssueDetail(t.db, USER, { id: empty.id }),
			await effectiveContextForIssue(t.db, USER, empty.id),
			[]
		);
		expect(emptyBlock).toContain('No artifacts attached.');
		expect(emptyBlock).toContain('Attach one: `tines issues artifacts attach');
	});
});
