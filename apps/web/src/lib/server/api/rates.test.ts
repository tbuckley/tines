import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-db';
import { seedBase, USER } from '../supervisor/test-fixtures';
import { ApiFail } from './core';
import { createRate, retireRate, validateCreateRate } from './rates';

const body = (overrides: Record<string, unknown> = {}) =>
	({
		model: 'future-model',
		input_rate: '3',
		cache_read_rate: '0.3',
		cache_write_rate: null,
		output_rate: '9',
		...overrides
	}) as Parameters<typeof validateCreateRate>[0];

function failure(fn: () => unknown) {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ApiFail);
		const fail = error as ApiFail;
		return { status: fail.status, code: fail.code };
	}
	throw new Error('expected validation to fail');
}

describe('validateCreateRate', () => {
	it('accepts decimals up to 9 places and exactly the cap', () => {
		expect(
			validateCreateRate(body({ input_rate: '0.123456789', output_rate: '1000000.000' }))
		).toMatchObject({ input_rate: '0.123456789', output_rate: '1000000.000', reprice: false });
	});

	it.each([
		['a float, not a string', 1.5],
		['10 fractional digits', '0.1234567891'],
		['a negative', '-1'],
		['a fraction above the cap', '1000000.5'],
		['a whole number above the cap', '1000001'],
		['a leading zero', '01']
	])('rejects %s', (_label, value) => {
		expect(failure(() => validateCreateRate(body({ input_rate: value })))).toEqual({
			status: 422,
			code: 'invalid_field'
		});
	});

	it('rejects a model that has a built-in rate', () => {
		expect(failure(() => validateCreateRate(body({ model: 'gpt-5.6-sol' })))).toEqual({
			status: 422,
			code: 'rate_builtin_exists'
		});
	});
});

describe('createRate and retireRate', () => {
	it('versions repeated saves and 404s a second retire', async () => {
		const t = createTestDb();
		seedBase(t);
		const first = await createRate(t.db, t.env, USER, body(), 10);
		const second = await createRate(t.db, t.env, USER, body({ output_rate: '12' }), 20);
		expect(first.rate).toMatchObject({ version: 1, output_rate: '9' });
		expect(second.rate).toMatchObject({ version: 2, output_rate: '12' });
		expect(second).toMatchObject({ repriced: 0, next_cursor: null });

		await retireRate(t.db, USER, second.rate.id, 30);
		await expect(retireRate(t.db, USER, second.rate.id, 40)).rejects.toMatchObject({
			status: 404,
			code: 'not_found'
		});
	});

	it('does not insert a rate for a built-in model', async () => {
		const t = createTestDb();
		seedBase(t);
		await expect(
			createRate(t.db, t.env, USER, body({ model: 'gpt-5.6-sol' }))
		).rejects.toMatchObject({ status: 422, code: 'rate_builtin_exists' });
		expect(t.sqlite.prepare('SELECT count(*) AS n FROM user_model_rate').get()).toEqual({ n: 0 });
	});
});
