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
		usage: AgentRunUsage | null;
	};
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
export function resumeEligibility(input: ResumeCandidateInput): ResumeEligibility {
	const { runner, predecessor, resource } = input;
	if (!runner.resume_enabled) return { eligible: false, reason: 'unsupported' };
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
	const usage = completeManagedUsage(predecessor.usage);
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
