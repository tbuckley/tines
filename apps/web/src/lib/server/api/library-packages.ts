import { LibraryValidationError } from '@tines/shared';
import { ApiFail } from './core';
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
