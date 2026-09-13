import { describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db';
import {
	concurrencyInstruction,
	projectConcurrencyControl,
	validateConcurrencyPoll,
	validateDeclinedAssignments
} from './runner-concurrency';

const row = (overrides: Partial<Database['runner']> = {}) =>
	({
		type: 'local',
		max_concurrent: 3,
		concurrency_mode: 'remote',
		concurrency_ceiling: 4,
		concurrency_requested: 3,
		concurrency_revision: 7,
		concurrency_instance_id: 'boot-a',
		concurrency_applied_revision: 7,
		concurrency_applied_cap: 3,
		concurrency_applied_instance_id: 'boot-a',
		concurrency_applied_at: 123,
		concurrency_unavailable_reason: null,
		daemon_instance_id: 'boot-a',
		...overrides
	}) as Database['runner'];

describe('local runner concurrency protocol', () => {
	it('strictly validates local consent, ceiling, acknowledgements, and declines', () => {
		expect(
			validateConcurrencyPoll(
				{ version: 1, allow_remote: true, ceiling: 4, applied: { revision: 2, cap: 3 } },
				'boot-a'
			)
		).toEqual({ version: 1, allow_remote: true, ceiling: 4, applied: { revision: 2, cap: 3 } });
		expect(() =>
			validateConcurrencyPoll({ version: 1, allow_remote: true, ceiling: 4.5 }, 'boot-a')
		).toThrow();
		expect(() =>
			validateConcurrencyPoll({ version: 2, allow_remote: true, ceiling: 4 }, 'boot-a')
		).toThrow();
		expect(() =>
			validateConcurrencyPoll({ version: 1, allow_remote: true, ceiling: 101 }, 'boot-a')
		).toThrow();
		expect(validateDeclinedAssignments(['run_a', 'run_b'])).toEqual(['run_a', 'run_b']);
		expect(() => validateDeclinedAssignments(['run_a', 'run_a'])).toThrow();
	});

	it('reports applied only for the current instance and exact revision/cap', () => {
		expect(projectConcurrencyControl(row(), true)).toMatchObject({
			status: 'applied',
			reason: null
		});
		expect(projectConcurrencyControl(row({ concurrency_revision: 8 }), true)).toMatchObject({
			status: 'pending'
		});
		expect(projectConcurrencyControl(row({ daemon_instance_id: 'boot-b' }), true)).toMatchObject({
			status: 'unavailable',
			reason: 'awaiting_policy'
		});
		expect(projectConcurrencyControl(row(), false)).toMatchObject({
			status: 'applied',
			reason: 'offline'
		});
	});

	it('never advertises remote availability for opted-out or stale instances', () => {
		expect(concurrencyInstruction(row({ concurrency_mode: 'local' }))).toMatchObject({
			available: false,
			reason: 'opted_out'
		});
		expect(concurrencyInstruction(row({ concurrency_instance_id: 'boot-old' }))).toMatchObject({
			available: false
		});
	});
});
