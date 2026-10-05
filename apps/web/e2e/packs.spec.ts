/**
 * Packs (docs/packs.md): install a `.tinespack` through the browser's review
 * screen, then check over the API that the pack's text renders with the
 * project's values, that an installed pack is read-only, and that export
 * gives back the same digest.
 */
import { type EffectiveContext, type PackExport, type PackSummary } from '@tines/shared';
import { packFilesFromRecord, writePackArchive } from '@tines/shared/packs';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, signIn } from './helpers';

function packArchive(id: string): Buffer {
	const files = packFilesFromRecord({
		'pack.yaml': `format: 1
id: ${id}
name: Triage kit
version: 2
description: A small triage workflow.
inputs:
  team:
    type: text
    description: The team that owns triage
`,
		'README.md': '# Triage kit\n\nSorts new bugs.\n',
		'project/conventions.md': 'You work for {{ inputs.team }}.\n',
		'workflows/triage/workflow.yaml': `name: Triage
initial: inbox
states:
  inbox:
    name: Inbox
    category: active
    transitions:
      Done: closed
  closed:
    name: Closed
    category: done
`,
		'workflows/triage/states/inbox/instructions.md': 'Label it and route it.\n'
	});
	return Buffer.from(writePackArchive(files, 'triage-kit'));
}

test('installs a pack from a file, renders its inputs, and exports it unchanged', async ({
	page,
	context,
	request,
	uniqueName
}) => {
	const alice = apiClient(request, ALICE.apiKey);
	const project = await body<{ id: string; name: string }>(
		await alice.post('/api/v1/projects', { name: uniqueName('packs') })
	);
	const packKey = `e2e/${uniqueName('triage')
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-')}`.slice(0, 60);

	await signIn(context, ALICE.sessionToken);
	await gotoHydrated(page, `/projects/${project.id}/packs/install`);
	await page.getByLabel('From a file').setInputFiles({
		name: 'triage-kit.tinespack',
		mimeType: 'application/zip',
		buffer: packArchive(packKey)
	});
	await expect(page.getByRole('heading', { name: 'Triage kit v2' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'What this pack adds' })).toBeVisible();
	await page.getByLabel(/team/).fill('Platform');
	await page.getByRole('button', { name: 'Install' }).click();
	await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/packs/pack_`));
	// The pack page's title, then the README's own heading.
	await expect(page.getByRole('heading', { name: 'Triage kit' }).first()).toBeVisible();
	await expect(page.getByText('installed', { exact: true })).toBeVisible();
	await expect(page.getByText('Needs setup')).toHaveCount(0);

	const packs = await body<{ items: PackSummary[] }>(
		await alice.get(`/api/v1/projects/${project.id}/packs`)
	);
	expect(packs.items).toHaveLength(1);
	const pack = packs.items[0];
	expect(pack).toMatchObject({ pack_key: packKey, version: 2, kind: 'installed', needs_setup: [] });

	// An issue on the pack's workflow reads the pack's text, rendered.
	const workflows = await body<{ items: { id: string; name: string; pack?: { id: string } }[] }>(
		await alice.get(`/api/v1/workflows?project=${project.id}`)
	);
	const triage = workflows.items.find((w) => w.pack?.id === pack.id);
	expect(triage?.name).toBe('Triage');
	const issue = await body<{ id: string }>(
		await alice.post(`/api/v1/projects/${project.id}/issues`, {
			title: 'A new bug',
			workflow_id: triage!.id
		})
	);
	const ctx = await body<EffectiveContext>(await alice.get(`/api/v1/issues/${issue.id}/context`));
	expect(ctx.prompt.text).toContain('You work for Platform.');
	expect(ctx.prompt.text).toContain('Label it and route it.');

	// Installed packs are read-only, for people and keys alike.
	const conventions = ctx.prompt.parts.find((p) => p.name === 'conventions')!;
	const refused = await errorBody(
		await alice.patch(`/api/v1/context/${conventions.item_id}`, { body: 'changed' })
	);
	expect(refused.error.code).toBe('pack_read_only');

	// Export hands back the installed version, byte for byte.
	const exported = await body<PackExport>(
		await alice.get(`/api/v1/projects/${project.id}/packs/${pack.id}/export`)
	);
	expect(exported).toMatchObject({ version: 2, digest: pack.digest, new_version: false });
});
