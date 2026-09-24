import { describe, expect, it } from 'vitest';
import { personalPermissionLabel } from './personal-permission.js';

describe('personalPermissionLabel', () => {
	it("shows the owner's unset as the default it admits", () => {
		expect(personalPermissionLabel('owner', 'unset')).toBe('on (owner default)');
		expect(personalPermissionLabel('owner', 'on')).toBe('on');
		expect(personalPermissionLabel('owner', 'off')).toBe('off');
	});

	it("leaves a member's unset unset", () => {
		expect(personalPermissionLabel('member', 'unset')).toBe('unset');
		expect(personalPermissionLabel('member', 'on')).toBe('on');
	});
});
