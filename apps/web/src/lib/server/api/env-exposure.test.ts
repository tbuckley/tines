import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { createContextItem } from './context';
import { createWorkflow } from './workflows';
import { assertImportableDocument, buildLibraryDocument } from './library';
import { buildLibraryV3Document } from './library-v3-export';
import { exportWorkflowPackage } from '../library/export';
import { validatePortableLibrary } from '../library/validate';
import { buildOwnedPublicationSourceProof } from '../publications/source';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function fixture() {
	const t = createTestDb();
	seedBase(t);
	t.env.SECRET_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
	const workflow = await createWorkflow(t.db, t.env, actor, {
		name: 'Export env exclusions',
		initial_state: 'Ready',
		states: [{ name: 'Ready', category: 'active' }],
		transitions: []
	});
	const scope = { workflow_state_id: workflow.states[0].id };
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'instructions',
		body: 'Keep this',
		...scope
	});
	for (const secret of [false, true]) {
		await createContextItem(t.db, t.env, actor, {
			kind: 'env',
			name: secret ? 'SECRET_TOKEN' : 'PUBLIC_CONFIG',
			value: secret ? 'private-credential' : 'public-configuration',
			secret,
			hint: 'private-hint',
			...scope
		});
	}
	return { t, workflow };
}

describe('env exposure exclusions', () => {
	it.each(['v2', 'v3', 'package', 'publication'] as const)(
		'excludes every env item from %s exports',
		async (surface) => {
			const { t, workflow } = await fixture();
			const result =
				surface === 'v2'
					? await buildLibraryDocument(t.db, USER)
					: surface === 'v3'
						? await buildLibraryV3Document(t.db, USER)
						: surface === 'package'
							? await exportWorkflowPackage(t.db, USER, workflow.id)
							: await buildOwnedPublicationSourceProof(t.db, USER, workflow.id, {});
			const document = 'document' in result ? result.document : result;
			expect(document.context.map((item) => item.name)).toEqual(['instructions']);
			const serialized = JSON.stringify(result);
			const rows = await t.db
				.selectFrom('context_item')
				.select('env_value_enc')
				.where('kind', '=', 'env')
				.execute();
			for (const forbidden of [
				'SECRET_TOKEN',
				'PUBLIC_CONFIG',
				'private-credential',
				'public-configuration',
				'private-hint',
				...rows.flatMap((row) => (row.env_value_enc ? [row.env_value_enc] : []))
			]) {
				expect(serialized).not.toContain(forbidden);
			}
		}
	);

	it('rejects env entries in v2 and v3 imports before writing any value', async () => {
		const { t } = await fixture();
		const v2 = await buildLibraryDocument(t.db, USER);
		const envEntry = {
			kind: 'env' as const,
			name: 'INJECTED',
			scope: {},
			value: 'do-not-import',
			secret: true
		};
		expect(() => assertImportableDocument({ ...v2, context: [envEntry] })).toThrow(
			'env items are deployment configuration'
		);
		const v3 = await buildLibraryV3Document(t.db, USER);
		const { digest: _, ...unsigned } = v3;
		const validation = await validatePortableLibrary(
			JSON.stringify({
				...unsigned,
				context: [{ ...envEntry, id: 'ctx_injected', description: '' }]
			})
		);
		expect(validation.valid).toBe(false);
		expect(validation.diagnostics.length).toBeGreaterThan(0);
	});
});
