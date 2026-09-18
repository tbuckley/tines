import type { EffortApplicationStatus } from '@tines/shared';

export interface EffortMilestone {
	status: 'accepted_unconfirmed' | 'confirmed' | 'rejected';
	transport: 'argv' | 'managed_agent_config';
	attempted_effort: string;
	observed_model?: string;
	observed_effort?: string;
	provider_agent_id?: string;
	reason?: string;
}

interface StoredEvidence {
	version: 1;
	milestones: Array<EffortMilestone & { received_at: number }>;
}

/** Monotonic, bounded merge: confirmation survives generic failures; conflicts stay sticky. */
export function mergeEffortEvidence(
	currentStatus: EffortApplicationStatus,
	currentRaw: string | null,
	incoming: EffortMilestone,
	now: number
): { status: EffortApplicationStatus; evidence: string } {
	let current: StoredEvidence = { version: 1, milestones: [] };
	try {
		const parsed = currentRaw ? (JSON.parse(currentRaw) as Partial<StoredEvidence>) : null;
		if (parsed?.version === 1 && Array.isArray(parsed.milestones)) {
			current = { version: 1, milestones: parsed.milestones.slice(0, 3) };
		} else if (parsed) {
			// Preserve a pre-merge-schema fact as the first bounded milestone.
			current.milestones.push(parsed as StoredEvidence['milestones'][number]);
		}
	} catch {
		// Invalid legacy evidence is replaced by the first validated milestone.
	}
	const identity = JSON.stringify(incoming);
	if (
		!current.milestones.some(
			(item) => JSON.stringify({ ...item, received_at: undefined }) === identity
		)
	)
		current.milestones.push({ ...incoming, received_at: now });
	current.milestones = current.milestones.slice(0, 3);

	const conflict =
		incoming.status === 'rejected' &&
		(incoming.observed_effort !== undefined || incoming.observed_model !== undefined);
	let status: EffortApplicationStatus;
	if (currentStatus === 'rejected' || conflict) status = 'rejected';
	else if (currentStatus === 'confirmed' || incoming.status === 'confirmed') status = 'confirmed';
	else if (currentStatus === 'accepted_unconfirmed' || incoming.status === 'accepted_unconfirmed')
		status = 'accepted_unconfirmed';
	else status = incoming.status;
	return { status, evidence: JSON.stringify(current) };
}
