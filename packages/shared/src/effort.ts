/** Shared, provider-neutral contract for reasoning-effort routing. */

export const EFFORT_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const EFFORT_CAPABILITIES_MAX_BYTES = 64 * 1024;
export const EFFORT_CAPABILITIES_MAX_MODELS = 256;
export const EFFORT_CAPABILITIES_MAX_EFFORTS = 16;

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
	discovery_error?: string;
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
