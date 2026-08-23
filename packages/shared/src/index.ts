/** Shared API types and client, used by both the web app and the CLI. */

export interface TimeResponse {
	/** ISO 8601 timestamp (UTC). */
	time: string;
	/** Milliseconds since the Unix epoch. */
	unix: number;
}

export interface ApiClientOptions {
	/** Base URL of the Tines API, e.g. "http://localhost:5173". */
	baseUrl: string;
	/** Custom fetch implementation (defaults to global fetch). */
	fetch?: typeof globalThis.fetch;
}

export function createApiClient(options: ApiClientOptions) {
	const base = options.baseUrl.replace(/\/+$/, '');
	const fetchFn = options.fetch ?? globalThis.fetch;

	async function get<T>(path: string): Promise<T> {
		const res = await fetchFn(`${base}${path}`, {
			headers: { accept: 'application/json' }
		});
		if (!res.ok) {
			throw new Error(`API request to ${path} failed: ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as T;
	}

	return {
		getTime: () => get<TimeResponse>('/api/time')
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
