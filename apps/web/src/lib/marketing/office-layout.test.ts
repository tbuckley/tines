import { describe, expect, it } from 'vitest';
import { officePhase, viewportCenter, type OfficeMeasurements } from './office-layout';

const base = (scrollY: number): OfficeMeasurements => ({
	width: 1440,
	height: 900,
	scrollY,
	end: 3000,
	apertures: [
		{ top: 500, height: 370, left: 255, width: 930, center: 685 },
		{ top: 1200, height: 630, left: 255, width: 930, center: 1515 },
		{ top: 2400, height: 460, left: 255, width: 930, center: 2630 }
	]
});

describe('officePhase', () => {
	it('preserves the seeded failed-review hold and continuation boundaries', () => {
		const boundaries = officePhase(base(0));
		expect(boundaries.returnAt - boundaries.failedAt).toBe(134);
		expect(officePhase(base(boundaries.failedAt + 1)).phase).toBe(1);
		expect(officePhase(base(boundaries.returnAt)).phase).toBe(2);
		expect(officePhase(base(boundaries.humanAt)).phase).toBe(3);
	});

	it('returns the same phase at an equal scroll position after reversal', () => {
		const before = officePhase(base(934));
		officePhase(base(1800));
		expect(officePhase(base(934))).toEqual(before);
	});

	it('reaches the completed office at maximum scroll on phone dimensions', () => {
		const phone = base(3000);
		phone.width = 390;
		phone.height = 844;
		expect(officePhase(phone).phase).toBe(4);
		expect(officePhase(phone).progress).toBe(2);
	});

	it('retains the center for height-only resize and remeasures on width changes', () => {
		expect(viewportCenter(700, 500, { width: 700, center: 387 })).toBe(387);
		expect(viewportCenter(701, 500, { width: 700, center: 387 })).toBe(215);
		expect(Number.isFinite(viewportCenter(320, 844))).toBe(true);
	});
});
