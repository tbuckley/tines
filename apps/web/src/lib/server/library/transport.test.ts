import { expect, it } from 'vitest';
import { readLibraryEnvelope } from './transport';
it('accepts exact byte limits and rejects one over, independent of Content-Length', async () => {
	const request = () =>
		new Request('http://test', { method: 'POST', body: 'é', headers: { 'content-length': '0' } });
	expect(await readLibraryEnvelope(request(), 2)).toBe('é');
	await expect(readLibraryEnvelope(request(), 1)).rejects.toMatchObject({
		code: 'document_too_large'
	});
});
it('rejects invalid UTF-8 instead of decoding replacement characters', async () => {
	await expect(
		readLibraryEnvelope(
			new Request('http://test', { method: 'POST', body: new Uint8Array([0xc3]) })
		)
	).rejects.toMatchObject({ code: 'invalid_utf8' });
});
