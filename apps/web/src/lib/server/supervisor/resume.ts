import type { AgentRunUsage, Runner } from '@tines/shared';
import type { Kysely } from 'kysely';
import type { Database, RunResourceTable } from '$lib/server/db';

export type ResumeFallbackReason = NonNullable<
	import('@tines/shared').AgentRun['resume_fallback_reason']
>;

export interface ResumeCandidateInput {
	now: number;
	runner: Pick<
		Runner,
		| 'id'
		| 'type'
		| 'config'
		| 'resume_enabled'
		| 'resume_window_hours'
		| 'resume_max_turns'
		| 'resume_max_tokens'
		| 'resume_max_cost_usd'
	>;
	predecessor: {
		id: string;
		runner_id: string;
		ended_at: number | null;
		outcome: string | null;
		conversation_turn_count: number | null;
	};
	/** Provider-level cumulative snapshot, never the predecessor run's public delta. */
	conversation_usage: AgentRunUsage | null;
	resource: Pick<
		RunResourceTable,
		'kind' | 'runner_id' | 'owner_run_id' | 'state' | 'expires_at' | 'resume_fingerprint'
	> | null;
	newest_ended_run_id: string;
	ended_in_awaiting_state: boolean;
	last_transition_authored_by_run: boolean;
	expected_fingerprint: string;
}

export type ResumeEligibility =
	{ eligible: true } | { eligible: false; reason: ResumeFallbackReason };

/**
 * Which providers can actually continue a conversation today. Claude Code
 * local runners can (`claude -p --resume <session-id>` in the kept
 * workspace); managed sessions cannot yet — their reuse needs the credential
 * ownership transfer, which is not built, so enabling it stays rejected.
 */
export function isResumeProviderSupported(
	type: Runner['type'],
	config: Record<string, unknown>
): boolean {
	return type === 'local' && (config.harness ?? 'claude_code') === 'claude_code';
}

/**
 * The compatibility fingerprint: everything about the launch that a resumed
 * conversation cannot be re-pointed at. A resource whose fingerprint no
 * longer matches the run we would launch is `incompatible` — we launch fresh
 * rather than continue a session whose harness, model or runner has moved.
 */
export function resumeFingerprint(input: {
	runnerId: string;
	harness: string;
	model: string | null;
	preambleVariant: string;
}): string {
	return [
		'v1',
		input.runnerId,
		input.harness,
		input.model ?? '(fixed)',
		input.preambleVariant
	].join('|');
}

function completeManagedUsage(usage: AgentRunUsage | null): Required<AgentRunUsage> | null {
	if (!usage) return null;
	const fields = [
		usage.input_tokens,
		usage.output_tokens,
		usage.cache_read_tokens,
		usage.cache_write_tokens,
		usage.cost_usd
	];
	if (fields.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
		return null;
	}
	return usage as Required<AgentRunUsage>;
}

/** Pure final eligibility check; dispatch affinity may use a cheaper preliminary query. */
export function resumeEligibility(
	input: ResumeCandidateInput,
	providerSupported = isResumeProviderSupported
): ResumeEligibility {
	const { runner, predecessor, resource } = input;
	if (!runner.resume_enabled || !providerSupported(runner.type, runner.config)) {
		return { eligible: false, reason: 'unsupported' };
	}
	if (
		predecessor.id !== input.newest_ended_run_id ||
		predecessor.runner_id !== runner.id ||
		predecessor.outcome !== 'advanced' ||
		!input.ended_in_awaiting_state ||
		!input.last_transition_authored_by_run
	) {
		return { eligible: false, reason: 'unavailable' };
	}
	if (
		!resource ||
		resource.state !== 'available' ||
		resource.runner_id !== runner.id ||
		resource.owner_run_id !== predecessor.id
	) {
		return { eligible: false, reason: 'unavailable' };
	}
	if (!predecessor.ended_at || !resource.expires_at)
		return { eligible: false, reason: 'unavailable' };
	const currentPolicyExpiry = predecessor.ended_at + runner.resume_window_hours * 60 * 60 * 1000;
	if (input.now >= Math.min(resource.expires_at, currentPolicyExpiry)) {
		return { eligible: false, reason: 'expired' };
	}
	if (resource.resume_fingerprint !== input.expected_fingerprint) {
		return { eligible: false, reason: 'incompatible' };
	}
	if (resource.kind === 'local_claude') {
		if (
			predecessor.conversation_turn_count === null ||
			predecessor.conversation_turn_count >= runner.resume_max_turns
		) {
			return { eligible: false, reason: 'long_context' };
		}
		return { eligible: true };
	}
	const usage = completeManagedUsage(input.conversation_usage);
	if (!usage) return { eligible: false, reason: 'unavailable' };
	const tokens =
		usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
	if (tokens >= runner.resume_max_tokens || usage.cost_usd >= runner.resume_max_cost_usd) {
		return { eligible: false, reason: 'long_context' };
	}
	return { eligible: true };
}

/** available→claimed is the single reuse/GC arbitration point. */
export async function claimResumeResource(
	db: Kysely<Database>,
	input: {
		resourceId: string;
		ownerRunId: string;
		claimRunId: string;
		claimToken: string;
		now: number;
	}
): Promise<boolean> {
	const result = await db
		.updateTable('run_resource')
		.set({
			state: 'claimed',
			claim_run_id: input.claimRunId,
			claim_token: input.claimToken,
			claim_started_at: input.now,
			transfer_phase: 'preparing',
			updated_at: input.now
		})
		.where('id', '=', input.resourceId)
		.where('owner_run_id', '=', input.ownerRunId)
		.where('state', '=', 'available')
		.where('expires_at', '>', input.now)
		.executeTakeFirst();
	return result.numUpdatedRows === 1n;
}

/** available→disposing races through the same state predicate as a claim. */
export async function claimResourceDisposal(
	db: Kysely<Database>,
	resourceId: string,
	now: number
): Promise<boolean> {
	const result = await db
		.updateTable('run_resource')
		.set({ state: 'disposing', updated_at: now })
		.where('id', '=', resourceId)
		.where('state', '=', 'available')
		.executeTakeFirst();
	return result.numUpdatedRows === 1n;
}

/**
 * Retention at the end of an awaiting run: the resource row that holds the
 * kept workspace and its Claude session against the GC until `expires_at`.
 * Written only for a run that advanced its issue into an awaiting state on a
 * resume-enabled runner, and only when the daemon reported both a session id
 * and the workspace it ran in — without either there is nothing to continue.
 */
export async function retainResumeResource(
	db: Kysely<Database>,
	input: {
		id: string;
		userId: string;
		runnerId: string;
		issueId: string;
		ownerRunId: string;
		providerSessionId: string;
		workspacePath: string;
		fingerprint: string;
		expiresAt: number;
		now: number;
	}
): Promise<void> {
	// One live resource per (runner, session): a session re-reported by a
	// second run supersedes the older row rather than colliding with the
	// partial unique index.
	await db
		.deleteFrom('run_resource')
		.where('runner_id', '=', input.runnerId)
		.where('provider_session_id', '=', input.providerSessionId)
		.execute();
	await db
		.insertInto('run_resource')
		.values({
			id: input.id,
			user_id: input.userId,
			runner_id: input.runnerId,
			issue_id: input.issueId,
			kind: 'local_claude',
			owner_run_id: input.ownerRunId,
			state: 'available',
			claim_run_id: null,
			claim_token: null,
			claim_started_at: null,
			transfer_phase: null,
			expires_at: input.expiresAt,
			available_seen_at: input.now,
			provider_session_id: input.providerSessionId,
			vault_id: null,
			credential_id: null,
			workspace_path: input.workspacePath,
			resume_fingerprint: input.fingerprint,
			transfer_data: null,
			created_at: input.now,
			updated_at: input.now
		})
		.execute();
}

/** The newest reusable resource for an issue on a runner, if any. */
export async function findResumeResource(
	db: Kysely<Database>,
	input: { userId: string; runnerId: string; issueId: string }
) {
	return db
		.selectFrom('run_resource')
		.selectAll()
		.where('user_id', '=', input.userId)
		.where('runner_id', '=', input.runnerId)
		.where('issue_id', '=', input.issueId)
		.where('state', '=', 'available')
		.orderBy('created_at desc')
		.executeTakeFirst();
}

/** GC: expired available resources, oldest first, for the disposal sweep. */
export async function expiredResumeResources(db: Kysely<Database>, now: number, limit = 50) {
	return db
		.selectFrom('run_resource')
		.selectAll()
		.where('state', '=', 'available')
		.where('expires_at', '<=', now)
		.orderBy('expires_at asc')
		.limit(limit)
		.execute();
}
