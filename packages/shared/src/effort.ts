/** Shared, provider-neutral contract for reasoning-effort routing. */

export const EFFORT_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const EFFORT_CAPABILITIES_MAX_BYTES = 64 * 1024;
export const EFFORT_CAPABILITIES_MAX_MODELS = 256;
export const EFFORT_CAPABILITIES_MAX_EFFORTS = 16;
/** Values verified for at least one supported provider/harness. */
export const RECOGNIZED_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

export type EffortApplicationStatus =
	| 'unknown'
	| 'not_requested'
	| 'legacy_not_applied'
	| 'pending'
	| 'accepted_unconfirmed'
	| 'confirmed'
	| 'rejected';

export type EffortSource =
	| {
			kind: 'routing_target';
			runner_id: string;
			tier: string;
			rule_id: string;
			scope_label: string;
			target_index: number;
	  }
	| { kind: 'runner_tier'; runner_id: string; tier: string }
	| { kind: 'none'; runner_id: string; tier: string };

export interface EffortModelCapability {
	model: string;
	efforts: string[];
}

export interface EffortCapabilitiesV1 {
	version: 1;
	daemon_version: string;
	harness: 'claude_code' | 'codex';
	harness_version: string;
	catalog_revision?: string;
	catalog_digest: string;
	models: EffortModelCapability[];
	/** This daemon can enforce user-asserted effort for unlisted models. */
	accepts_asserted_effort?: true;
	discovery_error?: string;
}

export type EffortAdmission =
	{ ok: true; verification: 'verified' | 'asserted' } | { ok: false; reason: string };

/** Admit an effort value against an exact-model catalog, optionally asserting an unlisted model. */
export function admitEffort(
	allowed: readonly string[] | null,
	value: string,
	assertable: boolean
): EffortAdmission {
	if (allowed !== null)
		return allowed.includes(value)
			? { ok: true, verification: 'verified' }
			: { ok: false, reason: `unsupported_effort: allows ${allowed.join(', ')}` };
	if (assertable && isRecognizedEffort(value)) return { ok: true, verification: 'asserted' };
	if (!assertable)
		return {
			ok: false,
			reason: 'daemon_upgrade_required: this daemon cannot accept effort for unlisted models'
		};
	return { ok: false, reason: 'capability_unavailable: exact model support was not reported' };
}

/** Verified managed-provider table; servers project this to clients. */
export const MANAGED_CLAUDE_EFFORTS: Readonly<Record<string, readonly string[]>> = {
	'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
	'claude-sonnet-4-6': ['low', 'medium', 'high', 'max']
};

export type EffortCapabilities = EffortCapabilitiesV1 | { version: number; reason: string };

export function isEffortToken(value: unknown): value is string {
	return typeof value === 'string' && EFFORT_TOKEN_PATTERN.test(value);
}

export function isRecognizedEffort(value: unknown): value is string {
	return isEffortToken(value) && (RECOGNIZED_EFFORT_VALUES as readonly string[]).includes(value);
}

/** Exact-model lookup: a capability assertion never applies to an alias or family. */
export function supportedEfforts(
	capabilities: EffortCapabilities | null | undefined,
	model: string | null
): readonly string[] | null {
	if (!capabilities || capabilities.version !== 1 || !('models' in capabilities) || !model)
		return null;
	return capabilities.models.find((entry) => entry.model === model)?.efforts ?? null;
}

export function effortLabel(value: string | null | undefined): string {
	return value ?? 'provider default';
}
