import { json } from '@sveltejs/kit';
import {
	diagnosticOf,
	LibraryValidationError,
	parsePublicWorkflowDocument,
	parseStrictLibraryJson,
	validatePublicationMetadata,
	type PublicationMetadata
} from '@tines/shared';
import { api, apiContext, ApiFail, requireJsonObject } from '$lib/server/api/core';
import { readLibraryEnvelope } from '$lib/server/library/transport';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	await apiContext(event);
	const raw = await readLibraryEnvelope(event.request);
	let body: Record<string, unknown>;
	try {
		body = requireJsonObject(parseStrictLibraryJson(raw));
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(400, 'invalid_json', error.message);
		throw error;
	}
	if (
		Object.keys(body).some((key) => key !== 'document_json' && key !== 'metadata') ||
		typeof body.document_json !== 'string'
	)
		throw new ApiFail(422, 'invalid_field', 'Expected {document_json: string, metadata?: object}');
	try {
		const result = await parsePublicWorkflowDocument(body.document_json);
		if (body.metadata !== undefined)
			validatePublicationMetadata(body.metadata as PublicationMetadata);
		return json({
			valid: result.diagnostics.length === 0,
			document_digest: result.document.digest,
			bytes_sha256: result.bytes_sha256,
			byte_length: result.byte_length,
			diagnostics: result.diagnostics,
			limits: { max_document_bytes: 1_048_576 }
		});
	} catch (error) {
		if (error instanceof LibraryValidationError)
			return json({
				valid: false,
				document_digest: null,
				bytes_sha256: null,
				byte_length: null,
				diagnostics: diagnosticOf(error).map((item) => ({
					...item,
					required: true,
					actions: ['repair_source', 'replace_file']
				})),
				limits: { max_document_bytes: 1_048_576 }
			});
		if (error instanceof Error)
			return json({
				valid: false,
				document_digest: null,
				bytes_sha256: null,
				byte_length: null,
				diagnostics: [
					{
						path: body.metadata === undefined ? '' : '/metadata',
						code: 'invalid_publication',
						message: error.message,
						required: true,
						actions: ['repair_source']
					}
				],
				limits: { max_document_bytes: 1_048_576 }
			});
		throw error;
	}
});
