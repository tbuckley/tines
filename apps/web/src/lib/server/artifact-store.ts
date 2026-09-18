/**
 * Artifact binary storage (specs/artifacts/SPEC.md "Storage").
 *
 * Server code talks to a minimal `ArtifactStore` interface so the artifact
 * module is testable without R2: the Worker passes the R2-backed store, the
 * unit-test harness gets an in-memory map (memoized per Env, so a test's
 * writes are visible to its later reads through the same fake Env).
 *
 * Keys are `art/{user_id}/{context_item_id}/{version_id}` — immutable, one
 * object per uploaded file version, never overwritten. A reaffirming version
 * stores no new object (its row reuses the source version's key), which is
 * safe because deletion is whole-artifact only: a prefix delete.
 */

export interface ArtifactStore {
	put(key: string, bytes: ArrayBuffer | Uint8Array): Promise<void>;
	/** Null when the object is missing. */
	get(key: string): Promise<Uint8Array | null>;
	delete(keys: string[]): Promise<void>;
	deletePrefix(prefix: string): Promise<void>;
}

export function artifactKey(userId: string, contextItemId: string, versionId: string): string {
	return `art/${userId}/${contextItemId}/${versionId}`;
}

/** One folder-version file object (still under the item prefix, so a
 * whole-artifact delete sweeps it). */
export function artifactFileKey(
	userId: string,
	contextItemId: string,
	versionId: string,
	fileId: string
): string {
	return `art/${userId}/${contextItemId}/${versionId}/${fileId}`;
}

export function artifactKeyPrefix(userId: string, contextItemId: string): string {
	return `art/${userId}/${contextItemId}/`;
}

class R2ArtifactStore implements ArtifactStore {
	constructor(private readonly bucket: NonNullable<Env['ARTIFACTS']>) {}
	async put(key: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
		await this.bucket.put(key, bytes as ArrayBuffer);
	}
	async get(key: string): Promise<Uint8Array | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return new Uint8Array(await object.arrayBuffer());
	}
	async delete(keys: string[]): Promise<void> {
		if (keys.length > 0) await this.bucket.delete(keys);
	}
	async deletePrefix(prefix: string): Promise<void> {
		// Artifacts cap at 50 versions, so one list page always covers a
		// whole-artifact delete; loop anyway for safety.
		let cursor: string | undefined;
		do {
			const page = await this.bucket.list({ prefix, cursor });
			await this.delete(page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
}

class MemoryArtifactStore implements ArtifactStore {
	private objects = new Map<string, Uint8Array>();
	async put(key: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
		this.objects.set(
			key,
			bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes)
		);
	}
	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key) ?? null;
	}
	async delete(keys: string[]): Promise<void> {
		for (const key of keys) this.objects.delete(key);
	}
	async deletePrefix(prefix: string): Promise<void> {
		for (const key of [...this.objects.keys()]) {
			if (key.startsWith(prefix)) this.objects.delete(key);
		}
	}
	/** Test hook: how many objects are stored under a prefix. */
	count(prefix = ''): number {
		return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).length;
	}
}

const memoryStores = new WeakMap<object, MemoryArtifactStore>();

/**
 * The store for an Env: R2-backed when the binding exists (production,
 * `wrangler dev`, e2e), else an in-memory store memoized per Env (unit
 * tests, whose fake Env has no ARTIFACTS binding).
 */
export function getArtifactStore(env: Env): ArtifactStore {
	if (env.ARTIFACTS) return new R2ArtifactStore(env.ARTIFACTS);
	let store = memoryStores.get(env);
	if (!store) {
		store = new MemoryArtifactStore();
		memoryStores.set(env, store);
	}
	return store;
}
