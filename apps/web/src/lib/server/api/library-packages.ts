import { LibraryValidationError } from '@tines/shared';
import { ApiFail } from './core';
import type { ActorContext } from './core';
import { requireAccess } from './permissions';
import { validatePortableLibrary } from '../library/validate';
export { validatePortableLibrary };
import { exportWorkflowPackage } from '../library/export';

/** Keep structured document diagnostics at the API boundary. */
export async function buildWorkflowPackage(...args: Parameters<typeof exportWorkflowPackage>) {
	try {
		const document = await exportWorkflowPackage(...args);
		const result = await validatePortableLibrary(JSON.stringify(document));
		if (!result.valid)
			throw new ApiFail(
				422,
				'invalid_library',
				result.diagnostics[0]?.message ?? 'Invalid exported package',
				{ diagnostics: result.diagnostics }
			);
		return document;
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(422, 'invalid_library', error.message, { diagnostics: error.diagnostics });
		throw error;
	}
}

export async function buildWorkflowPackageForActor(
	db: Parameters<typeof exportWorkflowPackage>[0],
	actor: ActorContext,
	workflowId: string,
	options: NonNullable<Parameters<typeof exportWorkflowPackage>[3]> = {}
) {
	const requirements = [
		{ domain: 'workspace' as const, access: 'read' as const },
		...(options.source_project_id
			? [
					{
						domain: 'project' as const,
						access: 'read' as const,
						projectId: options.source_project_id
					}
				]
			: [])
	];
	requireAccess(actor, requirements, 'library.export', {
		projectId: options.source_project_id
	});
	return buildWorkflowPackage(db, actor.userId, workflowId, options);
}
