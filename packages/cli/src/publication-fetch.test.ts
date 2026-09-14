import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchPublicWorkflowPackage, isPublicAddress } from './publication-fetch.js';

const ID = 'abcdefghijklmnopqrst';
const servers: Server[] = [];

async function serve(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ server: Server; base: string }> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('missing server address');
	return { server, base: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
	);
});

describe('credential-free public workflow package fetch', () => {
	it('pins a loopback development download and sends no ambient credentials or referrer', async () => {
		let headers: Record<string, string | string[] | undefined> = {};
		const { base } = await serve((request, response) => {
			headers = request.headers;
			response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
			response.end('{"ok":true}');
		});
		const result = await fetchPublicWorkflowPackage(`${base}/p/${ID}`);
		expect(result).toEqual({
			raw: '{"ok":true}',
			sourceUrl: `${base}/p/${ID}/download`
		});
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toBeUndefined();
		expect(headers.referer).toBeUndefined();
		expect(headers['proxy-authorization']).toBeUndefined();
	});

	it('rejects credentials, queries, fragments, noncanonical paths, and private targets', async () => {
		await expect(
			fetchPublicWorkflowPackage(`https://user:secret@example.com/p/${ID}`)
		).rejects.toThrow('credentials');
		await expect(fetchPublicWorkflowPackage(`https://example.com/p/${ID}?x=1`)).rejects.toThrow(
			'query'
		);
		await expect(fetchPublicWorkflowPackage(`https://example.com/p/${ID}#x`)).rejects.toThrow(
			'fragment'
		);
		await expect(fetchPublicWorkflowPackage('https://example.com/not-a-snapshot')).rejects.toThrow(
			'canonical'
		);
		await expect(fetchPublicWorkflowPackage(`http://192.168.1.2/p/${ID}`)).rejects.toThrow(
			'loopback'
		);
	});

	it('revalidates redirects and rejects invalid MIME, encoding, UTF-8, size, and timeout', async () => {
		const { base } = await serve((request, response) => {
			switch (request.url) {
				case `/p/${ID}/download`:
					response.writeHead(302, { location: `/final` });
					return response.end();
				case '/final':
					response.writeHead(200, { 'content-type': 'application/json' });
					return response.end('{"ok":true}');
				case `/p/${ID}aaaa/download`:
					response.writeHead(200, { 'content-type': 'text/plain' });
					return response.end('{}');
				case `/p/${ID}bbbb/download`:
					response.writeHead(200, {
						'content-type': 'application/json',
						'content-encoding': 'gzip'
					});
					return response.end('{}');
				case `/p/${ID}cccc/download`:
					response.writeHead(200, { 'content-type': 'application/json' });
					return response.end(Buffer.from([0xc3, 0x28]));
				case `/p/${ID}dddd/download`:
					response.writeHead(200, { 'content-type': 'application/json' });
					return response.end('{}');
				default:
					return undefined;
			}
		});
		await expect(fetchPublicWorkflowPackage(`${base}/p/${ID}`)).resolves.toMatchObject({
			raw: '{"ok":true}'
		});
		await expect(fetchPublicWorkflowPackage(`${base}/p/${ID}aaaa`)).rejects.toThrow(
			'application/json'
		);
		await expect(fetchPublicWorkflowPackage(`${base}/p/${ID}bbbb`)).rejects.toThrow('encoding');
		await expect(fetchPublicWorkflowPackage(`${base}/p/${ID}cccc`)).rejects.toThrow('UTF-8');
		await expect(
			fetchPublicWorkflowPackage(`${base}/p/${ID}dddd`, { maxBytes: 1 })
		).rejects.toThrow('too large');
		await expect(
			fetchPublicWorkflowPackage(`${base}/p/${ID}eeee`, { timeoutMs: 20 })
		).rejects.toThrow('timed out');
	});

	it('re-resolves and rejects a private address on every redirect hop', async () => {
		const { base } = await serve((_request, response) => {
			response.writeHead(302, { location: `https://redirected.test/p/${ID}/download` });
			response.end();
		});
		await expect(
			fetchPublicWorkflowPackage(`${base}/p/${ID}`, {
				lookup: (async (hostname: string) =>
					hostname === 'redirected.test'
						? [{ address: '2002:0a00:0001::1', family: 6 }]
						: [{ address: '127.0.0.1', family: 4 }]) as never
			})
		).rejects.toThrow('private or reserved');
	});

	it('classifies private, reserved, mapped, and public addresses', () => {
		for (const address of [
			'10.0.0.1',
			'100.64.0.1',
			'169.254.1.1',
			'172.16.0.1',
			'192.168.1.1',
			'198.51.100.2',
			'203.0.113.4',
			'::1',
			'fc00::1',
			'fe80::1',
			'100::1',
			'2001::1',
			'2001:2::1',
			'2001:db8::1',
			'2002:0a00:0001::1',
			'3fff::1',
			'::ffff:c0a8:101'
		])
			expect(isPublicAddress(address), address).toBe(false);
		expect(isPublicAddress('1.1.1.1')).toBe(true);
		expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
	});
});
