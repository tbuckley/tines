import { ApiFail } from '../api/core';

export const LIBRARY_ENVELOPE_MAX_BYTES = 32 * 1024 * 1024;

/** Bound allocation before decoding; replacement characters must not hide invalid UTF-8. */
export async function readLibraryEnvelope(
	request: Request,
	maxBytes = LIBRARY_ENVELOPE_MAX_BYTES
): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return '';
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	const chunks: string[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes)
				throw new ApiFail(422, 'document_too_large', `Request exceeds ${maxBytes} bytes`, {
					max_bytes: maxBytes
				});
			chunks.push(decoder.decode(value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join('');
	} catch (error) {
		await reader.cancel().catch(() => {});
		if (error instanceof TypeError)
			throw new ApiFail(400, 'invalid_utf8', 'Request must be valid UTF-8');
		throw error;
	} finally {
		reader.releaseLock();
	}
}
