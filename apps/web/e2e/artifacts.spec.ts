import type { IssueDetail, Project, WorkflowResponse } from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BOB } from './constants.mjs';
import { apiClient, body, runId } from './helpers';

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

interface ArtifactShape {
	name: string;
	artifact_type: string;
	fresh: boolean;
	current_version: {
		version: number;
		filename: string | null;
		content_type: string | null;
		size_bytes: number | null;
		file_count: number | null;
		files?: { path: string; content_type: string; size_bytes: number }[];
		reaffirmed_from: number | null;
		pr_repo_url: string | null;
		pr_number: number | null;
	};
}

/**
 * The artifacts acceptance loop (specs/artifacts/SPEC.md) over the real HTTP
 * API and wrangler's local R2: gate a transition on a design doc, attach,
 * pass, send back (stale), attach v2, reaffirm, and serve content safely.
 */
test.describe.serial('issue artifacts', () => {
	const projectName = `artifacts-${runId}`;
	let projectId: string;
	let workflowId: string;
	let issueId: string;
	let issueRef: string;

	const requirement = {
		artifact: 'design-doc',
		type: 'file',
		content_type: 'text/markdown',
		description: 'The approved design document for this round'
	};

	test('a workflow PATCH round-trips transition requirements', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const wf = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `Design loop ${runId}`,
				initial_state: 'Design',
				states: [
					{ name: 'Design', category: 'active' },
					{ name: 'Implementation', category: 'active' },
					{ name: 'Done', category: 'done' }
				],
				transitions: [
					{ name: 'approve', from: 'Design', to: 'Implementation', requires: [requirement] },
					{ name: 'send back', from: 'Implementation', to: 'Design' },
					{ name: 'ship', from: 'Implementation', to: 'Done' }
				]
			})
		);
		workflowId = wf.id;
		expect(wf.transitions.find((t) => t.name === 'approve')?.requires).toEqual([requirement]);

		// Round-trips through an update that re-creates the transition rows.
		const patched = await body<WorkflowResponse>(
			await api.patch(`/api/v1/workflows/${workflowId}`, { description: 'gated' })
		);
		expect(patched.transitions.find((t) => t.name === 'approve')?.requires).toEqual([requirement]);

		projectId = (await body<Project>(await api.post('/api/v1/projects', { name: projectName }))).id;
		const issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${projectId}/issues`, {
				title: 'Gated work',
				workflow_id: workflowId
			})
		);
		issueId = issue.id;
		issueRef = `${issue.project_name}/${issue.number}`;
	});

	test('the gated move is blocked with a structured, self-correcting 422', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const res = await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' });
		expect(res.status()).toBe(422);
		const err = await body<ErrorBody>(res);
		expect(err.error.code).toBe('transition_requirements_unmet');
		const unmet = err.error.details?.unmet as Record<string, unknown>[];
		expect(unmet[0]).toMatchObject({ artifact: 'design-doc', status: 'missing' });
		expect(String(unmet[0].fix)).toContain(`tines issues artifacts attach ${issueRef} design-doc`);

		// Pre-flight visibility on the issue read and the launch prompt.
		const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		const approve = issue.allowed_transitions.find((t) => t.name === 'approve');
		expect(approve?.requires?.[0]).toMatchObject({ artifact: 'design-doc', status: 'missing' });
		const prompt = await body<{ text: string }>(await api.get(`/api/v1/issues/${issueId}/prompt`));
		expect(prompt.text).toContain('No artifacts attached.');
		expect(prompt.text).toContain('Requires: artifact `design-doc`');
	});

	test('uploading the doc (raw body → R2) satisfies the gate', async ({ request }) => {
		const headers = { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': 'text/markdown' };
		const upload = await request.put(
			`/api/v1/issues/${issueId}/artifacts/design-doc/file?filename=design.md`,
			{ headers, data: Buffer.from('# The design\n\nv1.') }
		);
		expect(upload.ok()).toBe(true);
		const artifact = await body<ArtifactShape>(upload);
		expect(artifact).toMatchObject({
			artifact_type: 'file',
			fresh: true,
			current_version: { version: 1, filename: 'design.md', content_type: 'text/markdown' }
		});

		const api = apiClient(request, ALICE.apiKey);
		const moved = await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' });
		expect(moved.ok()).toBe(true);
		expect((await body<IssueDetail>(moved)).state.name).toBe('Implementation');
	});

	test('sending back stales the doc; a new version and a reaffirm each unblock', async ({
		request
	}) => {
		const api = apiClient(request, ALICE.apiKey);
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'send back' });

		const listed = await body<{ items: ArtifactShape[] }>(
			await api.get(`/api/v1/issues/${issueId}/artifacts`)
		);
		expect(listed.items[0].fresh).toBe(false);
		const blocked = await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' });
		expect(blocked.status()).toBe(422);
		const unmet = (await body<ErrorBody>(blocked)).error.details?.unmet as Record<
			string,
			unknown
		>[];
		expect(unmet[0]).toMatchObject({ status: 'stale', current_version: { version: 1 } });

		// v2 unblocks; both versions stay downloadable with distinct contents.
		const headers = { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': 'text/markdown' };
		await request.put(`/api/v1/issues/${issueId}/artifacts/design-doc/file?filename=design.md`, {
			headers,
			data: Buffer.from('# The design\n\nv2.')
		});
		expect(
			(await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' })).ok()
		).toBe(true);
		const v1 = await api.get(`/api/v1/issues/${issueId}/artifacts/design-doc/content?version=1`);
		const v2 = await api.get(`/api/v1/issues/${issueId}/artifacts/design-doc/content?version=2`);
		expect(await v1.text()).toContain('v1.');
		expect(await v2.text()).toContain('v2.');

		// Back once more: reaffirm blesses v2's exact bytes as v3.
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'send back' });
		const reaffirmed = await body<ArtifactShape>(
			await api.post(`/api/v1/issues/${issueId}/artifacts/design-doc/reaffirm`)
		);
		expect(reaffirmed.current_version).toMatchObject({ version: 3, reaffirmed_from: 2 });
		const v3 = await api.get(`/api/v1/issues/${issueId}/artifacts/design-doc/content`);
		expect(await v3.text()).toContain('v2.');
		expect(
			(await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'approve' })).ok()
		).toBe(true);
		await api.post(`/api/v1/issues/${issueId}/transition`, { action: 'send back' });
	});

	test('content serving is attachment-by-default, inline only sandboxed', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const headers = { authorization: `Bearer ${ALICE.apiKey}`, 'content-type': 'image/png' };
		await request.put(
			`/api/v1/issues/${issueId}/artifacts/feature-screenshot/file?filename=shot.png`,
			{
				headers,
				data: Buffer.from([0x89, 0x50, 0x4e, 0x47])
			}
		);

		const attachment = await api.get(
			`/api/v1/issues/${issueId}/artifacts/feature-screenshot/content`
		);
		expect(attachment.headers()['x-content-type-options']).toBe('nosniff');
		expect(attachment.headers()['content-disposition']).toBe('attachment; filename="shot.png"');

		const inline = await api.get(
			`/api/v1/issues/${issueId}/artifacts/feature-screenshot/content?inline=1`
		);
		expect(inline.headers()['content-disposition']).toBe('inline; filename="shot.png"');
		expect(inline.headers()['content-security-policy']).toBe('sandbox');
	});

	test('pr artifacts store the reference; text/link ride the JSON upsert', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const pr = await body<ArtifactShape>(
			await api.put(`/api/v1/issues/${issueId}/artifacts/impl-pr`, {
				type: 'pr',
				pr_url: 'https://github.com/acme/app/pull/123'
			})
		);
		expect(pr.current_version).toMatchObject({
			pr_repo_url: 'https://github.com/acme/app',
			pr_number: 123
		});
		const noContent = await api.get(`/api/v1/issues/${issueId}/artifacts/impl-pr/content`);
		expect(noContent.status()).toBe(422);
		expect((await body<ErrorBody>(noContent)).error.code).toBe('no_content');

		const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
		expect(issue.context_summary.artifacts).toBe(3);
	});

	test('oversize and cross-user requests are refused', async ({ request }) => {
		const alice = apiClient(request, ALICE.apiKey);
		// The text cap names the limit (the 25MB file cap is unit-tested; a
		// >256KB JSON body keeps this spec fast).
		const big = await alice.put(`/api/v1/issues/${issueId}/artifacts/too-big`, {
			type: 'text',
			content: 'x'.repeat(256 * 1024 + 1)
		});
		expect(big.status()).toBe(422);
		expect((await body<ErrorBody>(big)).error.code).toBe('artifact_too_large');

		const bob = apiClient(request, BOB.apiKey);
		expect((await bob.get(`/api/v1/issues/${issueId}/artifacts`)).status()).toBe(404);
		expect((await bob.get(`/api/v1/issues/${issueId}/artifacts/design-doc/content`)).status()).toBe(
			404
		);
	});

	test('the generic context surface lists but never creates artifacts', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const create = await api.post('/api/v1/context', {
			kind: 'artifact',
			name: 'nope',
			issue_id: issueId
		});
		expect(create.status()).toBe(422);
		expect((await body<ErrorBody>(create)).error.code).toBe('use_artifact_endpoints');

		const listed = await body<{ items: { kind: string; name: string; artifact_type?: string }[] }>(
			await api.get(`/api/v1/context?issue=${issueId}`)
		);
		const artifactItems = listed.items.filter((i) => i.kind === 'artifact');
		expect(artifactItems.map((i) => i.name).sort()).toEqual([
			'design-doc',
			'feature-screenshot',
			'impl-pr'
		]);
		expect(artifactItems.every((i) => typeof i.artifact_type === 'string')).toBe(true);
	});

	test('folder snapshots upload whole (multipart) and serve per path', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const headers = { authorization: `Bearer ${ALICE.apiKey}` };
		// One multipart part per file: path as the filename, MIME as the type.
		// Mixed types and a subfolder in one snapshot.
		const put = await request.put(`/api/v1/issues/${issueId}/artifacts/screenshots/folder`, {
			headers,
			multipart: {
				f0: { name: 'login.png', mimeType: 'image/png', buffer: Buffer.from('PNG1') },
				f1: { name: 'settings/billing.png', mimeType: 'image/png', buffer: Buffer.from('PNG2') },
				f2: { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# notes') }
			}
		});
		expect(put.ok()).toBe(true);
		const artifact = await body<ArtifactShape>(put);
		expect(artifact).toMatchObject({
			artifact_type: 'folder',
			fresh: true,
			current_version: { version: 1, file_count: 3, size_bytes: 15 }
		});

		// Per-path serving under the safety headers; no path → 422 listing paths.
		const file = await api.get(
			`/api/v1/issues/${issueId}/artifacts/screenshots/content?path=${encodeURIComponent('settings/billing.png')}`
		);
		expect(await file.text()).toBe('PNG2');
		expect(file.headers()['x-content-type-options']).toBe('nosniff');
		expect(file.headers()['content-disposition']).toBe('attachment; filename="billing.png"');
		const noPath = await api.get(`/api/v1/issues/${issueId}/artifacts/screenshots/content`);
		expect(noPath.status()).toBe(422);
		const noPathErr = await body<ErrorBody>(noPath);
		expect(noPathErr.error.code).toBe('folder_path_required');
		expect(noPathErr.error.details?.paths).toEqual([
			'login.png',
			'notes.md',
			'settings/billing.png'
		]);

		// The JSON upsert refuses folder payload writes, naming the endpoint.
		const bad = await api.put(`/api/v1/issues/${issueId}/artifacts/screenshots`, { content: 'x' });
		expect(bad.status()).toBe(422);
		expect((await body<ErrorBody>(bad)).error.code).toBe('use_folder_endpoint');

		// A new snapshot replaces the set wholesale; v1 stays addressable.
		const v2 = await request.put(`/api/v1/issues/${issueId}/artifacts/screenshots/folder`, {
			headers,
			multipart: { f0: { name: 'login.png', mimeType: 'image/png', buffer: Buffer.from('PNG1b') } }
		});
		expect((await body<ArtifactShape>(v2)).current_version).toMatchObject({
			version: 2,
			file_count: 1
		});
		const old = await api.get(
			`/api/v1/issues/${issueId}/artifacts/screenshots/content?version=1&path=notes.md`
		);
		expect(await old.text()).toBe('# notes');

		// Reaffirm copies the set (same objects, fresh timestamp); detail
		// reads carry the file list per version.
		const reaffirmed = await body<ArtifactShape>(
			await api.post(`/api/v1/issues/${issueId}/artifacts/screenshots/reaffirm`)
		);
		expect(reaffirmed.current_version).toMatchObject({
			version: 3,
			reaffirmed_from: 2,
			file_count: 1
		});
		const detail = await body<ArtifactShape>(
			await api.get(`/api/v1/issues/${issueId}/artifacts/screenshots`)
		);
		expect(detail.current_version.files?.map((f) => f.path)).toEqual(['login.png']);

		await api.delete(`/api/v1/issues/${issueId}/artifacts/screenshots`);
	});

	test('deleting an artifact removes every version', async ({ request }) => {
		const api = apiClient(request, ALICE.apiKey);
		const del = await api.delete(`/api/v1/issues/${issueId}/artifacts/design-doc`);
		expect(del.status()).toBe(204);
		expect((await api.get(`/api/v1/issues/${issueId}/artifacts/design-doc`)).status()).toBe(404);
		expect((await api.get(`/api/v1/issues/${issueId}/artifacts/design-doc/content`)).status()).toBe(
			404
		);
	});
});
