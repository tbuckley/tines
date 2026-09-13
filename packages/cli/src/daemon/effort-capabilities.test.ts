import type { EffortCapabilitiesV1, RunnerAssignment } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { assignmentEffortRejection } from './effort-capabilities.js';

const capabilities: EffortCapabilitiesV1 = {
	version: 1,
	daemon_version: '0.0.194',
	harness: 'codex',
	harness_version: '0.153.4',
	catalog_digest: 'catalog-a',
	models: [{ model: 'gpt-5.6', efforts: ['low', 'high'] }]
};

function assignment(value = 'low', digest = 'catalog-a'): RunnerAssignment {
	return {
		run: { id: 'arun_1', model: 'gpt-5.6' },
		effort: {
			version: 1,
			value,
			capability_digest: digest,
			source: { kind: 'runner_tier', runner_id: 'rnr_1', tier: 'balanced' }
		}
	} as unknown as RunnerAssignment;
}

describe('assignmentEffortRejection', () => {
	it('accepts only the delivered catalog, exact model, value and harness', () => {
		expect(assignmentEffortRejection(assignment(), capabilities, 'codex')).toBeNull();
		expect(assignmentEffortRejection(assignment('ultra'), capabilities, 'codex')).toContain(
			'does not support'
		);
		expect(
			assignmentEffortRejection(assignment('low', 'catalog-b'), capabilities, 'codex')
		).toContain('catalog changed');
		expect(assignmentEffortRejection(assignment(), capabilities, 'claude_code')).toContain(
			'this daemon runs claude_code'
		);
		expect(assignmentEffortRejection(assignment(), undefined, 'codex')).toContain('requires');
	});

	it('preserves old assignments without an effort block', () => {
		const old = { run: { id: 'arun_old' } } as unknown as RunnerAssignment;
		expect(assignmentEffortRejection(old, undefined, 'custom')).toBeNull();
	});
});
