import { describe, expect, it } from 'vitest';
import { LIST_MAX_PX, LIST_MIN_PX, listMaxHeight } from './popover-fit';

describe('listMaxHeight', () => {
	it('grows to the full list height when there is plenty of room', () => {
		expect(listMaxHeight(100, 800)).toBe(LIST_MAX_PX);
	});

	it('ends a gap above the limit when room is between the floor and the max', () => {
		// 779 − 600.5 − 8 = 170.5, floored.
		expect(listMaxHeight(600.5, 779)).toBe(170);
	});

	it('never shrinks below about three rows', () => {
		expect(listMaxHeight(760, 779)).toBe(LIST_MIN_PX);
		expect(listMaxHeight(900, 779)).toBe(LIST_MIN_PX);
	});
});
