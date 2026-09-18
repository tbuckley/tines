/**
 * The oldest Codex CLI whose rollout files the daemon reconciles for per-request
 * context proof. Newer releases are accepted as long as they keep the same
 * `session_meta` / `token_count` record shape; a release that changes the shape
 * fails the structural reconciliation instead of the version gate.
 */
export const CODEX_ROLLOUT_MIN_VERSION = '0.153.4';

function parseVersion(value: string): [number, number, number] | null {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const minimum = parseVersion(CODEX_ROLLOUT_MIN_VERSION)!;

/** True for a plain `major.minor.patch` Codex CLI version at or above the minimum. */
export function isSupportedCodexRolloutVersion(version: unknown): boolean {
	if (typeof version !== 'string') return false;
	const parsed = parseVersion(version);
	if (!parsed) return false;
	for (let i = 0; i < 3; i++) {
		if (parsed[i] !== minimum[i]) return parsed[i] > minimum[i];
	}
	return true;
}
