import { describe, expect, it } from 'vitest';
import { deltaLabel, durationLabel, shareLabel } from './stats-format';

describe('durationLabel', () => {
	it('scales the unit and blanks null', () => {
		expect(durationLabel(null)).toBe('—');
		expect(durationLabel(30_000)).toBe('30 s');
		expect(durationLabel(42 * 60_000)).toBe('42 min');
		expect(durationLabel(3.1 * 3_600_000)).toBe('3.1 h');
		expect(durationLabel(2.4 * 86_400_000)).toBe('2.4 d');
	});
});

describe('deltaLabel', () => {
	it('separates "no change" from "not comparable"', () => {
		expect(deltaLabel(null, 'count')).toBe('');
		expect(deltaLabel(0, 'count')).toBe('=');
	});

	it('prints a direction and a unit-appropriate size', () => {
		expect(deltaLabel(3, 'count')).toBe('▲ 3');
		expect(deltaLabel(-2, 'count')).toBe('▼ 2');
		expect(deltaLabel(-90 * 60_000, 'ms')).toBe('▼ 90 min');
		expect(deltaLabel(0.2, 'share')).toBe('▲ 20 pp');
		expect(deltaLabel(-1.25, 'ratio')).toBe('▼ 1.3');
	});
});

describe('shareLabel', () => {
	it('rounds to whole percent', () => {
		expect(shareLabel(null)).toBe('—');
		expect(shareLabel(11 / 55)).toBe('20%');
	});
});
