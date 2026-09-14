import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { PUBLIC_WORKFLOW_MAX_BYTES } from '@tines/shared';

const SNAPSHOT_PATH = /^\/p\/[A-Za-z0-9_-]{20,100}(?:\/download)?$/;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface PublicationFetchOptions {
	lookup?: typeof dnsLookup;
	timeoutMs?: number;
	maxBytes?: number;
}

function mappedIpv4(address: string): string | undefined {
	const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
	if (match) return match[1];
	const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
	if (!hexadecimal) return undefined;
	const high = Number.parseInt(hexadecimal[1], 16);
	const low = Number.parseInt(hexadecimal[2], 16);
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isLoopback(address: string): boolean {
	const mapped = mappedIpv4(address);
	if (mapped) return isLoopback(mapped);
	return address === '::1' || /^127\./.test(address);
}

/** Fail closed for ranges that must never be reached by a supplied publication URL. */
export function isPublicAddress(address: string): boolean {
	const mapped = mappedIpv4(address);
	if (mapped) return isPublicAddress(mapped);
	if (isIP(address) === 4) {
		const [a, b] = address.split('.').map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 2) ||
			(a === 192 && b === 88) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51) ||
			(a === 203 && b === 0 && Number(address.split('.')[2]) === 113)
		);
	}
	if (isIP(address) === 6) {
		const normalized = address.toLowerCase();
		return !(
			normalized === '::' ||
			normalized === '::1' ||
			/^f[cd]/.test(normalized) ||
			/^fe[89ab]/.test(normalized) ||
			/^ff/.test(normalized) ||
			normalized.startsWith('2001:db8:')
		);
	}
	return false;
}

function validateHop(url: URL, initial: boolean): void {
	if (!['http:', 'https:'].includes(url.protocol))
		throw new Error('publication URL must use HTTPS');
	if (url.username || url.password) throw new Error('publication URL must not contain credentials');
	if (url.hash) throw new Error('publication URL must not contain a fragment');
	if (url.search) throw new Error('publication URL must not contain query parameters');
	if (initial && !SNAPSHOT_PATH.test(url.pathname))
		throw new Error('expected a canonical public snapshot or download URL');
}

async function pinnedAddress(url: URL, lookup: typeof dnsLookup) {
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const literalFamily = isIP(hostname);
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily }]
		: await lookup(hostname, { all: true, verbatim: true });
	if (!addresses.length) throw new Error(`publication host ${url.hostname} did not resolve`);
	const loopbackDevelopment =
		url.protocol === 'http:' &&
		(url.hostname === 'localhost' || addresses.every(({ address }) => isLoopback(address)));
	if (url.protocol === 'http:' && !loopbackDevelopment)
		throw new Error(
			'publication URL must use HTTPS (HTTP is allowed only for loopback development)'
		);
	if (!loopbackDevelopment && addresses.some(({ address }) => !isPublicAddress(address)))
		throw new Error('publication URL resolves to a private or reserved address');
	return addresses[0];
}

async function readHop(
	url: URL,
	options: Required<Pick<PublicationFetchOptions, 'timeoutMs' | 'maxBytes'>> & {
		lookup: typeof dnsLookup;
	}
): Promise<{ body?: string; redirect?: URL }> {
	const pinned = await pinnedAddress(url, options.lookup);
	return new Promise((resolve, reject) => {
		const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
			url,
			{
				method: 'GET',
				headers: { accept: 'application/json' },
				lookup: (_hostname, _opts, callback) =>
					callback(null, pinned.address, pinned.family as 4 | 6)
			},
			(response) => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400) {
					response.resume();
					const location = response.headers.location;
					if (!location) return reject(new Error('publication redirect has no destination'));
					try {
						return resolve({ redirect: new URL(location, url) });
					} catch {
						return reject(new Error('publication redirect has an invalid destination'));
					}
				}
				if (status !== 200) {
					response.resume();
					return reject(new Error(`publication download returned HTTP ${status}`));
				}
				const contentType = String(response.headers['content-type'] ?? '')
					.split(';', 1)[0]
					.trim()
					.toLowerCase();
				if (contentType !== 'application/json') {
					response.resume();
					return reject(new Error('publication download must be application/json'));
				}
				const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
				if (encoding !== 'identity') {
					response.resume();
					return reject(new Error('publication download uses unsupported content encoding'));
				}
				let size = 0;
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > options.maxBytes)
						response.destroy(new Error('publication download is too large'));
					else chunks.push(chunk);
				});
				response.on('end', () => {
					try {
						resolve({
							body: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
								Buffer.concat(chunks)
							)
						});
					} catch {
						reject(new Error('publication download is not valid UTF-8'));
					}
				});
			}
		);
		const deadline = setTimeout(
			() => request.destroy(new Error('publication download timed out')),
			options.timeoutMs
		);
		request.on('close', () => clearTimeout(deadline));
		request.on('error', reject);
		request.end();
	});
}

export async function fetchPublicWorkflowPackage(
	value: string,
	options: PublicationFetchOptions = {}
): Promise<{ raw: string; sourceUrl: string }> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('expected a canonical public snapshot or download URL');
	}
	validateHop(url, true);
	if (!url.pathname.endsWith('/download')) url.pathname += '/download';
	const sourceUrl = url.toString();
	for (let redirects = 0; ; redirects += 1) {
		validateHop(url, false);
		const result = await readHop(url, {
			lookup: options.lookup ?? dnsLookup,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxBytes: options.maxBytes ?? PUBLIC_WORKFLOW_MAX_BYTES
		});
		if (result.body !== undefined) return { raw: result.body, sourceUrl };
		if (!result.redirect || redirects >= MAX_REDIRECTS)
			throw new Error('publication download exceeded three redirects');
		if (url.protocol === 'https:' && result.redirect.protocol !== 'https:')
			throw new Error('publication redirect must not downgrade HTTPS');
		url = result.redirect;
	}
}
