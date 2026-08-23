import { describe, expect, it } from 'vitest';
import { newId, randomString } from './db';

describe('randomString', () => {
	it('produces the requested length from the 62-char alphabet', () => {
		for (const len of [1, 16, 40, 100]) {
			const s = randomString(len);
			expect(s).toHaveLength(len);
			expect(s).toMatch(/^[0-9a-zA-Z]+$/);
		}
	});

	it('does not repeat (sanity check on randomness)', () => {
		const seen = new Set(Array.from({ length: 50 }, () => randomString(16)));
		expect(seen.size).toBe(50);
	});
});

describe('newId', () => {
	it('prefixes ids with the entity tag', () => {
		expect(newId('iss')).toMatch(/^iss_[0-9a-zA-Z]{16}$/);
	});
});
