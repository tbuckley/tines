import { describe, expect, it } from 'vitest';
import { mergeEffortEvidence } from './effort-evidence';

describe('mergeEffortEvidence', () => {
	it('is idempotent and does not let a generic late failure erase delivery', () => {
		const delivered = mergeEffortEvidence(
			'pending',
			null,
			{ status: 'accepted_unconfirmed', transport: 'argv', attempted_effort: 'high' },
			1
		);
		const duplicate = mergeEffortEvidence(
			delivered.status,
			delivered.evidence,
			{ status: 'accepted_unconfirmed', transport: 'argv', attempted_effort: 'high' },
			2
		);
		const failed = mergeEffortEvidence(
			duplicate.status,
			duplicate.evidence,
			{ status: 'rejected', transport: 'argv', attempted_effort: 'high', reason: 'late close' },
			3
		);
		expect(failed.status).toBe('accepted_unconfirmed');
		expect(JSON.parse(failed.evidence).milestones).toHaveLength(2);
	});

	it('makes an observed conflict sticky across later confirmation', () => {
		const conflict = mergeEffortEvidence(
			'confirmed',
			null,
			{
				status: 'rejected',
				transport: 'managed_agent_config',
				attempted_effort: 'high',
				observed_effort: 'medium'
			},
			1
		);
		const later = mergeEffortEvidence(
			conflict.status,
			conflict.evidence,
			{ status: 'confirmed', transport: 'managed_agent_config', attempted_effort: 'high' },
			2
		);
		expect(later.status).toBe('rejected');
	});
});
