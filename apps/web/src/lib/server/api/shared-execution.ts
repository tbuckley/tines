/**
 * Release flag for shared execution guidance (Tines/752). Off unless the
 * worker's `SHARED_EXECUTION` var is exactly `on`: production and preview
 * leave it unset, the E2E worker sets it. With the flag off every path is
 * today's, and the guidance-inclusion routes answer 404.
 */
export function sharedExecutionEnabled(env: Pick<Env, 'SHARED_EXECUTION'>): boolean {
	return env.SHARED_EXECUTION === 'on';
}

/** Conversion to shared is one-way, so `shared_at` alone decides. */
export function isSharedProject(row: { shared_at: number | null }): boolean {
	return row.shared_at !== null;
}
