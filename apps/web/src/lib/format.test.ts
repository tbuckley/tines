import { describe, expect, it } from 'vitest';
import { truncate } from './format';

describe('truncate', () => {
	it('leaves short values alone', () => {
		expect(truncate('QA Playground', 60)).toBe('QA Playground');
	});

	it('never exceeds the limit, ellipsis included', () => {
		const clamped = truncate('x'.repeat(200), 60);
		expect(clamped).toHaveLength(60);
		expect(clamped.endsWith('…')).toBe(true);
	});

	it('keeps a value of exactly the limit intact', () => {
		expect(truncate('x'.repeat(60), 60)).toBe('x'.repeat(60));
	});
});
