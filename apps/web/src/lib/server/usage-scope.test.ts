import { describe, expect, it } from 'vitest';
import {
	mintUsageCursor,
	mintUsageScope,
	verifyUsageCursor,
	verifyUsageScope,
	type UsageCursorPayload,
	type UsageScopePayload
} from './usage-scope';

const material = 'usage-scope-test-secret';
const scope: UsageScopePayload = {
	v: 1,
	owner: 'usr_one',
	mode: 'period',
	from: 10,
	to: 20,
	timezone: 'UTC',
	timezone_source: 'utc_fallback',
	filters: { project: 'prj_one', outcome: 'advanced' },
	by: 'workflow'
};

describe('usage scope signatures', () => {
	it('round trips a frozen selection and rejects tampering', async () => {
		const token = await mintUsageScope(scope, material);
		expect(await verifyUsageScope(token, material)).toEqual(scope);
		const changed = `${token.slice(0, -2)}aa`;
		await expect(verifyUsageScope(changed, material)).rejects.toThrow('invalid token');
	});

	it('rejects unsupported shapes even with a valid signature', async () => {
		const token = await mintUsageScope({ ...scope, extra: true } as UsageScopePayload, material);
		await expect(verifyUsageScope(token, material)).rejects.toThrow('unsupported usage scope');
	});

	it('binds cursor ordering and boundary fields', async () => {
		const cursor: UsageCursorPayload = {
			v: 1,
			scope: await mintUsageScope(scope, material),
			kind: 'issues',
			population: 'finalized',
			member: null,
			sort: 'cost',
			direction: 'desc',
			traversal: 'after',
			boundary: { cost: '0.001', at: 19, id: 'iss_one' }
		};
		const token = await mintUsageCursor(cursor, material);
		expect(await verifyUsageCursor(token, material)).toEqual(cursor);
		await expect(verifyUsageCursor(token, 'rotated-secret')).rejects.toThrow('invalid token');
	});
});
