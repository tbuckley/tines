import {
	ISSUE_CREATE_MAX_FILES,
	ISSUE_CREATE_METADATA_MAX_BYTES,
	ISSUE_CREATE_MULTIPART_MAX_BYTES,
	type CreateIssueMultipartMetadata,
	type CreateIssueRequest
} from '@tines/shared';
import { ApiFail } from './core';
import type { ActorContext } from './core';
import { assertConsentFieldsSupported } from './personal-consent';
import type { InitialIssueFile } from './artifacts';

export interface ParsedIssueCreate {
	issue: CreateIssueRequest;
	files: InitialIssueFile[];
}

function invalid(message: string, details?: Record<string, unknown>): never {
	throw new ApiFail(422, 'invalid_field', message, details);
}

/** Parse the bounded multipart representation used only by issue creation. */
export async function readIssueCreateMultipart(
	request: Request,
	actor?: ActorContext
): Promise<ParsedIssueCreate> {
	const header = request.headers.get('content-length');
	const declared = header === null ? NaN : Number(header);
	if (!Number.isSafeInteger(declared) || declared < 0) {
		throw new ApiFail(411, 'length_required', 'A valid Content-Length is required');
	}
	if (declared > ISSUE_CREATE_MULTIPART_MAX_BYTES) {
		throw new ApiFail(422, 'artifact_too_large', 'Multipart issue creation is too large', {
			max_bytes: ISSUE_CREATE_MULTIPART_MAX_BYTES,
			size_bytes: declared
		});
	}

	let actual = 0;
	let overflow = false;
	const source = request.body?.getReader();
	if (!source) invalid('Multipart request body is required');
	const bounded = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await source.read();
			if (next.done) return controller.close();
			actual += next.value.byteLength;
			if (actual > ISSUE_CREATE_MULTIPART_MAX_BYTES) {
				overflow = true;
				await source.cancel();
				return controller.error(new Error('multipart body limit exceeded'));
			}
			controller.enqueue(next.value);
		},
		cancel(reason) {
			return source.cancel(reason);
		}
	});
	let form: FormData;
	try {
		form = await new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: bounded,
			duplex: 'half'
		} as RequestInit).formData();
	} catch {
		if (overflow) {
			throw new ApiFail(422, 'artifact_too_large', 'Multipart issue creation is too large', {
				max_bytes: ISSUE_CREATE_MULTIPART_MAX_BYTES,
				size_bytes: actual
			});
		}
		invalid('Request body must be valid multipart form data');
	}
	if (actual !== declared) {
		invalid('Content-Length does not match the multipart body', {
			declared_bytes: declared,
			actual_bytes: actual
		});
	}

	const entries = [...form.entries()];
	const metadataEntries = entries.filter(([key]) => key === 'metadata');
	if (metadataEntries.length !== 1 || typeof metadataEntries[0]?.[1] !== 'string') {
		invalid('Multipart requests require exactly one string "metadata" field', {
			field: 'metadata'
		});
	}
	const metadataText = metadataEntries[0][1] as string;
	if (new TextEncoder().encode(metadataText).byteLength > ISSUE_CREATE_METADATA_MAX_BYTES) {
		throw new ApiFail(422, 'artifact_too_large', 'Multipart metadata is too large', {
			field: 'metadata',
			max_bytes: ISSUE_CREATE_METADATA_MAX_BYTES
		});
	}
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataText);
	} catch {
		invalid('"metadata" must be valid JSON', { field: 'metadata' });
	}
	if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
		invalid('Invalid metadata');
	const candidate = metadata as Partial<CreateIssueMultipartMetadata>;
	if (actor)
		assertConsentFieldsSupported(actor, candidate, ['allow_my_agents', 'disclosure_version']);
	if (!candidate.issue || typeof candidate.issue !== 'object' || Array.isArray(candidate.issue)) {
		invalid('"metadata.issue" must be an object', { field: 'metadata.issue' });
	}
	if (!Array.isArray(candidate.attachments)) {
		invalid('"metadata.attachments" must be an array', { field: 'metadata.attachments' });
	}
	if (candidate.attachments.length < 1 || candidate.attachments.length > ISSUE_CREATE_MAX_FILES) {
		throw new ApiFail(422, 'artifact_file_limit', `Choose 1–${ISSUE_CREATE_MAX_FILES} files`, {
			max_files: ISSUE_CREATE_MAX_FILES
		});
	}

	const expected = new Set(['metadata']);
	const files: InitialIssueFile[] = candidate.attachments.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			invalid(`Attachment ${index} must be an object`, { attachment_index: index });
		}
		const part = `file-${index}`;
		if (
			entry.part !== part ||
			typeof entry.name !== 'string' ||
			typeof entry.filename !== 'string'
		) {
			invalid(`Attachment ${index} must name part "${part}"`, { attachment_index: index });
		}
		expected.add(part);
		const values = entries.filter(([key]) => key === part);
		if (values.length !== 1 || typeof values[0]?.[1] === 'string') {
			invalid(`Part "${part}" must contain exactly one file`, {
				attachment_index: index,
				field: part
			});
		}
		const file = values[0][1] as File;
		return {
			name: entry.name,
			filename: entry.filename,
			contentType: file.type || 'application/octet-stream',
			body: file
		};
	});
	const extra = entries.find(([key]) => !expected.has(key));
	if (extra) invalid(`Unlisted multipart part "${extra[0]}"`, { field: extra[0] });
	return { issue: candidate.issue as CreateIssueRequest, files };
}
