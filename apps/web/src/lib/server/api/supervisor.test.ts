import { describe, expect, it } from 'vitest';
import { ApiFail } from './core';
import { validateAttemptLimit, validateQuotaPolicy } from './supervisor';

describe('validateQuotaPolicy', () => {
	it('accepts a global cap with a positive limit', () => {
		expect(validateQuotaPolicy({ type: 'global_cap', limit: 3 })).toEqual({
			type: 'global_cap',
			limit: 3
		});
	});

	it('rejects a global cap of 0 — the kill switch is the off-switch', () => {
		expect(() => validateQuotaPolicy({ type: 'global_cap', limit: 0 })).toThrowError(ApiFail);
	});

	it('rejects non-integer and missing limits', () => {
		expect(() => validateQuotaPolicy({ type: 'global_cap', limit: 2.5 })).toThrowError(ApiFail);
		expect(() => validateQuotaPolicy({ type: 'global_cap' })).toThrowError(ApiFail);
		expect(() => validateQuotaPolicy({ type: 'global_cap', limit: '3' })).toThrowError(ApiFail);
	});

	it('accepts a state roster, allowing 0 (no agents work this stage)', () => {
		expect(
			validateQuotaPolicy({
				type: 'state_roster',
				default_limit: 0,
				overrides: { s_open: 3, s_review: 0 }
			})
		).toEqual({ type: 'state_roster', default_limit: 0, overrides: { s_open: 3, s_review: 0 } });
	});

	it('defaults absent overrides to an empty map', () => {
		expect(validateQuotaPolicy({ type: 'state_roster', default_limit: 1 })).toEqual({
			type: 'state_roster',
			default_limit: 1,
			overrides: {}
		});
	});

	it('rejects bad override values', () => {
		expect(() =>
			validateQuotaPolicy({ type: 'state_roster', default_limit: 1, overrides: { s: -1 } })
		).toThrowError(ApiFail);
		expect(() =>
			validateQuotaPolicy({ type: 'state_roster', default_limit: 1, overrides: { s: 'many' } })
		).toThrowError(ApiFail);
	});

	it('rejects unknown policy types, listing the allowed ones', () => {
		try {
			validateQuotaPolicy({ type: 'per_project', limit: 1 });
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).details?.allowed_types).toEqual(['global_cap', 'state_roster']);
		}
	});

	it('rejects stray fields — the policy shape is typed, not a grab bag', () => {
		expect(() => validateQuotaPolicy({ type: 'global_cap', limit: 3, extra: true })).toThrowError(ApiFail);
		expect(() =>
			validateQuotaPolicy({ type: 'state_roster', default_limit: 1, limit: 3 })
		).toThrowError(ApiFail);
	});

	it('rejects non-object payloads', () => {
		expect(() => validateQuotaPolicy(null)).toThrowError(ApiFail);
		expect(() => validateQuotaPolicy([])).toThrowError(ApiFail);
		expect(() => validateQuotaPolicy('global_cap')).toThrowError(ApiFail);
	});
});

describe('validateAttemptLimit', () => {
	it('accepts small positive integers', () => {
		expect(validateAttemptLimit(1)).toBe(1);
		expect(validateAttemptLimit(3)).toBe(3);
	});

	it('rejects 0, negatives, and non-integers', () => {
		expect(() => validateAttemptLimit(0)).toThrowError(ApiFail);
		expect(() => validateAttemptLimit(-1)).toThrowError(ApiFail);
		expect(() => validateAttemptLimit(2.5)).toThrowError(ApiFail);
		expect(() => validateAttemptLimit('3')).toThrowError(ApiFail);
	});
});
