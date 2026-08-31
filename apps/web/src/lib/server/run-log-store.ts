/**
 * Full run-log storage (Tines/66).
 *
 * The D1 `agent_run.log` column keeps a 256 KB tail; the bytes it evicts are
 * written here so a run's complete output survives. Like `artifact-store.ts`,
 * server code talks to a minimal interface so the log logic is testable
 * without R2: the Worker passes the R2-backed store, unit tests get an
 * in-memory map memoized per Env.
 *
 * A separate bucket from `ARTIFACTS` on purpose: different retention (logs
 * are GC'd after 30 days, artifacts are kept), and a different blast radius
 * for an accidental prefix delete.
 *
 * Keys all live under one per-run prefix, so retention is a single
 * `deletePrefix`:
 *   runlog/{user_id}/{run_id}/part.{00000001}  one spilled eviction
 *   runlog/{user_id}/{run_id}/head             parts 1..k, compacted
 *   runlog/{user_id}/{run_id}/full             the sealed complete log
 *   runlog/{user_id}/{run_id}/raw.ndjson       the raw harness stream
 * Part indices are zero-padded to 8 digits so R2's lexicographic list order
 * is numeric order.
 */

export interface RunLogObject {
	body: ReadableStream<Uint8Array>;
	size: number;
}

export interface RunLogStore {
	put(key: string, body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>, size?: number): Promise<void>;
	/** Null when the object is missing. */
	get(key: string): Promise<Uint8Array | null>;
	/**
	 * Streaming read, for objects too large to buffer (a sealed multi-MB
	 * log). Null when the object is missing.
	 */
	getStream(key: string): Promise<RunLogObject | null>;
	delete(keys: string[]): Promise<void>;
	deletePrefix(prefix: string): Promise<void>;
	/**
	 * One page of keys under a prefix, in lexicographic order (R2 pages at
	 * 1,000). `cursor` continues a page chain; `startAfter` resumes from a
	 * remembered key, which is what the orphan sweep walks the keyspace with
	 * across passes — unlike a cursor it stays meaningful between sweeps.
	 */
	list(
		prefix: string,
		opts?: { cursor?: string; startAfter?: string }
	): Promise<{ keys: string[]; cursor?: string }>;
}

export function runLogPrefix(userId: string, runId: string): string {
	return `runlog/${userId}/${runId}/`;
}

/** One spilled eviction. `index` is 1-based and matches `log_part_count`. */
export function runLogPartKey(userId: string, runId: string, index: number): string {
	return `${runLogPrefix(userId, runId)}part.${String(index).padStart(8, '0')}`;
}

/** Parts `1..log_compacted_through`, merged by the sweep. */
export function runLogHeadKey(userId: string, runId: string): string {
	return `${runLogPrefix(userId, runId)}head`;
}

/** The sealed complete log: head + remaining parts + the final tail. */
export function runLogFullKey(userId: string, runId: string): string {
	return `${runLogPrefix(userId, runId)}full`;
}

/** The unrendered harness stream (claude_code NDJSON), uploaded at settle. */
export function runLogRawKey(userId: string, runId: string): string {
	return `${runLogPrefix(userId, runId)}raw.ndjson`;
}

/** `runlog/{user}/{run}/…` → the run id, or null for an unparseable key. */
export function runIdFromLogKey(key: string): string | null {
	const parts = key.split('/');
	if (parts.length < 4 || parts[0] !== 'runlog') return null;
	return parts[2] || null;
}

class R2RunLogStore implements RunLogStore {
	constructor(private readonly bucket: NonNullable<Env['RUN_LOGS']>) {}
	async put(
		key: string,
		body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
		size?: number
	): Promise<void> {
		// R2 only accepts a stream whose length it already knows. Every caller
		// here passes a `Request` body, which carries its own Content-Length,
		// so `size` is asserted rather than forwarded — there is no
		// R2PutOptions member to forward a length through. Buffered bodies
		// carry their own length and need no assertion.
		if (body instanceof ReadableStream) {
			if (size === undefined) throw new Error('run-log store: streaming put requires a size');
			await this.bucket.put(key, body as never, {
				httpMetadata: { contentType: 'text/plain; charset=utf-8' }
			});
			return;
		}
		await this.bucket.put(key, body as ArrayBuffer);
	}
	async get(key: string): Promise<Uint8Array | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return new Uint8Array(await object.arrayBuffer());
	}
	async getStream(key: string): Promise<RunLogObject | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { body: object.body as unknown as ReadableStream<Uint8Array>, size: object.size };
	}
	async delete(keys: string[]): Promise<void> {
		if (keys.length > 0) await this.bucket.delete(keys);
	}
	async deletePrefix(prefix: string): Promise<void> {
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({ prefix, cursor });
			await this.delete(page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	async list(
		prefix: string,
		opts?: { cursor?: string; startAfter?: string }
	): Promise<{ keys: string[]; cursor?: string }> {
		const page = await this.bucket.list({ prefix, ...opts });
		return {
			keys: page.objects.map((o) => o.key),
			cursor: page.truncated ? page.cursor : undefined
		};
	}
}

export class MemoryRunLogStore implements RunLogStore {
	private objects = new Map<string, Uint8Array>();
	/**
	 * R2 pages `list` at 1,000; tests lower this to exercise the orphan
	 * sweep's walk across pages without seeding a thousand objects.
	 */
	pageSize = 1000;
	async put(
		key: string,
		body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
		size?: number
	): Promise<void> {
		if (body instanceof ReadableStream) {
			// Mirror R2's requirement, so a caller that forgets the size
			// fails in tests rather than only in production.
			if (size === undefined) throw new Error('run-log store: streaming put requires a size');
			const chunks: Uint8Array[] = [];
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value) chunks.push(value);
			}
			const total = chunks.reduce((n, c) => n + c.length, 0);
			const joined = new Uint8Array(total);
			let at = 0;
			for (const c of chunks) {
				joined.set(c, at);
				at += c.length;
			}
			this.objects.set(key, joined);
			return;
		}
		this.objects.set(key, new Uint8Array(body as ArrayBuffer));
	}
	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key) ?? null;
	}
	async getStream(key: string): Promise<RunLogObject | null> {
		const bytes = this.objects.get(key);
		if (!bytes) return null;
		return {
			size: bytes.length,
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				}
			})
		};
	}
	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.objects.delete(key);
	}
	async deletePrefix(prefix: string): Promise<void> {
		for (const key of [...this.objects.keys()]) {
			if (key.startsWith(prefix)) this.objects.delete(key);
		}
	}
	async list(
		prefix: string,
		opts?: { cursor?: string; startAfter?: string }
	): Promise<{ keys: string[]; cursor?: string }> {
		const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
		const after = opts?.cursor ?? opts?.startAfter;
		// Both forms resume after a key; R2's cursor is opaque, but an
		// in-memory store can just use the key itself for both.
		const start = after ? all.findIndex((k) => k > after) : 0;
		const from = start === -1 ? all.length : start;
		const keys = all.slice(from, from + this.pageSize);
		const truncated = from + keys.length < all.length;
		return { keys, cursor: truncated ? keys[keys.length - 1] : undefined };
	}
	/** Test hook: how many objects are stored under a prefix. */
	count(prefix = ''): number {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).length;
	}
	/** Test hook: every key under a prefix, in list order. */
	keys(prefix = ''): string[] {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
	}
}

const memoryStores = new WeakMap<object, MemoryRunLogStore>();

/**
 * The store for an Env: R2-backed when the binding exists (production,
 * `wrangler dev`, e2e), else an in-memory store memoized per Env (unit
 * tests, whose fake Env has no RUN_LOGS binding).
 */
export function getRunLogStore(env: Env): RunLogStore {
	if (env.RUN_LOGS) return new R2RunLogStore(env.RUN_LOGS);
	let store = memoryStores.get(env);
	if (!store) {
		store = new MemoryRunLogStore();
		memoryStores.set(env, store);
	}
	return store;
}
