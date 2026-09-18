import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parsePublicSnapshotUrl, PUBLIC_WORKFLOW_MAX_BYTES } from '@tines/shared';

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

function ipv6Integer(address: string): bigint | undefined {
	let value = address.toLowerCase();
	const dotted = /(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
	if (dotted) {
		const octets = dotted[1].split('.').map(Number);
		if (octets.some((octet) => octet > 255)) return undefined;
		value = `${value.slice(0, dotted.index)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = value.split('::');
	if (halves.length > 2) return undefined;
	const left = halves[0] ? halves[0].split(':') : [];
	const right = halves[1] ? halves[1].split(':') : [];
	const missing = 8 - left.length - right.length;
	if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
	const groups = [...left, ...Array(missing).fill('0'), ...right];
	if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group)))
		return undefined;
	return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Range(value: bigint, base: string, prefix: number): boolean {
	const baseValue = ipv6Integer(base);
	if (baseValue === undefined) return false;
	const shift = BigInt(128 - prefix);
	return value >> shift === baseValue >> shift;
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
		const value = ipv6Integer(address);
		if (value === undefined || !inIpv6Range(value, '2000::', 3)) return false;
		return ![
			['2001::', 23], // IETF protocol assignments, including Teredo and benchmarking
			['2001:db8::', 32], // documentation
			['2002::', 16], // 6to4 (may embed a private IPv4 destination)
			['2620:4f:8000::', 48], // documentation
			['3fff::', 20] // documentation
		].some(([base, prefix]) => inIpv6Range(value, base as string, prefix as number));
	}
	return false;
}

function validateHop(url: URL): void {
	if (!['http:', 'https:'].includes(url.protocol))
		throw new Error('publication URL must use HTTPS');
	if (url.username || url.password) throw new Error('publication URL must not contain credentials');
	if (url.hash) throw new Error('publication URL must not contain a fragment');
	if (url.search) throw new Error('publication URL must not contain query parameters');
}

type PinnedAddress = { address: string; family: number };

async function pinnedAddresses(url: URL, lookup: typeof dnsLookup): Promise<PinnedAddress[]> {
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const literalFamily = isIP(hostname);
	const addresses = literalFamily
		? [{ address: hostname, family: literalFamily }]
		: await lookup(hostname, { all: true, verbatim: true });
	if (
		!addresses.length ||
		addresses.some(({ address, family }) => isIP(address) !== family || ![4, 6].includes(family))
	)
		throw new Error(`publication host ${url.hostname} did not resolve to valid addresses`);
	const literalLoopback = Boolean(literalFamily && isLoopback(hostname));
	const loopbackDevelopment =
		url.protocol === 'http:' &&
		(url.hostname === 'localhost' || literalLoopback) &&
		addresses.every(({ address }) => isLoopback(address));
	if (url.protocol === 'http:' && !loopbackDevelopment)
		throw new Error(
			'publication URL must use HTTPS (HTTP is allowed only for loopback development)'
		);
	if (!loopbackDevelopment && addresses.some(({ address }) => !isPublicAddress(address)))
		throw new Error('publication URL resolves to a private or reserved address');
	return addresses;
}

function pinnedLookup(addresses: PinnedAddress[]) {
	return (
		_hostname: string,
		opts: { all?: boolean; family?: number },
		callback: (error: Error | null, address?: string | PinnedAddress[], family?: number) => void
	) => {
		const family = typeof opts.family === 'number' ? opts.family : 0;
		const matching =
			family === 4 || family === 6 ? addresses.filter((item) => item.family === family) : addresses;
		if (!matching.length)
			return callback(new Error(`publication host has no IPv${family} address`));
		if (opts.all) return callback(null, matching);
		return callback(null, matching[0].address, matching[0].family);
	};
}

async function readHop(
	url: URL,
	options: Required<Pick<PublicationFetchOptions, 'timeoutMs' | 'maxBytes'>> & {
		lookup: typeof dnsLookup;
	}
): Promise<{ body?: string; redirect?: URL }> {
	const pinned = await pinnedAddresses(url, options.lookup);
	return new Promise((resolve, reject) => {
		const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
			url,
			{
				method: 'GET',
				headers: { accept: 'application/json' },
				lookup: pinnedLookup(pinned) as never
			},
			(response) => {
				let responseFailure: Error | undefined;
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
					if (size > options.maxBytes) {
						responseFailure = new Error('publication download is too large');
						response.destroy(responseFailure);
					} else chunks.push(chunk);
				});
				response.on('aborted', () =>
					reject(responseFailure ?? new Error('publication download was aborted'))
				);
				response.on('error', reject);
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
	const parsed = parsePublicSnapshotUrl(value);
	let url = new URL(parsed.downloadUrl);
	const sourceUrl = parsed.downloadUrl;
	for (let redirects = 0; ; redirects += 1) {
		validateHop(url);
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
