import type {
	RunnerConcurrencyControl,
	RunnerConcurrencyUnavailableReason,
	RunnerPollRequest,
	RunnerPollResponse
} from '@tines/shared';
import type { Database } from '$lib/server/db';
import { ApiFail } from './core';

type RunnerRow = Database['runner'];

function boundedInt(value: unknown, field: string, min = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > 100) {
		throw new ApiFail(
			422,
			'invalid_field',
			`"${field}" must be an integer between ${min} and 100`,
			{
				field
			}
		);
	}
	return value as number;
}

function revision(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new ApiFail(422, 'invalid_field', `"${field}" must be a nonnegative safe integer`, {
			field
		});
	return value as number;
}

export function validateConcurrencyPoll(
	value: unknown,
	instanceId?: string
): RunnerPollRequest['concurrency_control'] | null {
	if (value === undefined) return null;
	if (!instanceId)
		throw new ApiFail(422, 'invalid_field', '"concurrency_control" requires "instance_id"', {
			field: 'concurrency_control'
		});
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new ApiFail(422, 'invalid_field', '"concurrency_control" must be an object', {
			field: 'concurrency_control'
		});
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || typeof raw.allow_remote !== 'boolean')
		throw new ApiFail(422, 'invalid_field', 'malformed V1 concurrency control report', {
			field: 'concurrency_control'
		});
	const ceiling = boundedInt(raw.ceiling, 'concurrency_control.ceiling', 1);
	let applied: { revision: number; cap: number } | undefined;
	if (raw.applied !== undefined) {
		if (typeof raw.applied !== 'object' || raw.applied === null || Array.isArray(raw.applied))
			throw new ApiFail(422, 'invalid_field', 'malformed concurrency acknowledgement', {
				field: 'concurrency_control.applied'
			});
		const ack = raw.applied as Record<string, unknown>;
		applied = {
			revision: revision(ack.revision, 'concurrency_control.applied.revision'),
			cap: boundedInt(ack.cap, 'concurrency_control.applied.cap', 1)
		};
	}
	return { version: 1, allow_remote: raw.allow_remote, ceiling, ...(applied ? { applied } : {}) };
}

export function validateDeclinedAssignments(value: unknown): string[] {
	if (value === undefined) return [];
	if (
		!Array.isArray(value) ||
		value.length > 100 ||
		value.some(
			(id) =>
				typeof id !== 'string' || id.length < 1 || id.length > 128 || !/^[\x21-\x7e]+$/.test(id)
		) ||
		new Set(value).size !== value.length
	)
		throw new ApiFail(
			422,
			'invalid_field',
			'"declined_assignments" must contain up to 100 unique ASCII run ids',
			{ field: 'declined_assignments' }
		);
	return value;
}

export function projectConcurrencyControl(
	runner: RunnerRow,
	online: boolean
): RunnerConcurrencyControl | null {
	if (runner.type !== 'local') return null;
	const currentInstance =
		runner.concurrency_instance_id !== null &&
		runner.concurrency_instance_id === runner.daemon_instance_id;
	if (runner.concurrency_mode !== 'remote' || !currentInstance) {
		const reason =
			runner.concurrency_unavailable_reason as RunnerConcurrencyUnavailableReason | null;
		return {
			status: 'unavailable',
			reason:
				runner.concurrency_mode === 'local'
					? 'opted_out'
					: runner.concurrency_mode === 'remote'
						? 'awaiting_policy'
						: (reason ?? 'legacy'),
			requested_cap: runner.concurrency_requested,
			ceiling: runner.concurrency_ceiling,
			revision: runner.concurrency_revision,
			applied_cap: runner.concurrency_applied_cap,
			applied_revision: runner.concurrency_applied_revision,
			applied_at: runner.concurrency_applied_at
		};
	}
	const applied =
		runner.concurrency_applied_revision === runner.concurrency_revision &&
		runner.concurrency_applied_cap === runner.concurrency_requested &&
		runner.concurrency_applied_instance_id === runner.concurrency_instance_id;
	return {
		status: applied ? 'applied' : 'pending',
		reason: online ? null : 'offline',
		requested_cap: runner.concurrency_requested,
		ceiling: runner.concurrency_ceiling,
		revision: runner.concurrency_revision,
		applied_cap: runner.concurrency_applied_cap,
		applied_revision: runner.concurrency_applied_revision,
		applied_at: runner.concurrency_applied_at
	};
}

export function concurrencyInstruction(
	runner: RunnerRow
): RunnerPollResponse['concurrency_control'] {
	const available =
		runner.concurrency_mode === 'remote' &&
		runner.concurrency_instance_id !== null &&
		runner.concurrency_instance_id === runner.daemon_instance_id;
	return {
		version: 1,
		available,
		revision: runner.concurrency_revision,
		cap: runner.concurrency_requested ?? runner.max_concurrent,
		ceiling: runner.concurrency_ceiling,
		...(!available
			? {
					reason: (runner.concurrency_unavailable_reason ??
						(runner.concurrency_mode === 'local'
							? 'opted_out'
							: 'legacy')) as RunnerConcurrencyUnavailableReason
				}
			: {})
	};
}
