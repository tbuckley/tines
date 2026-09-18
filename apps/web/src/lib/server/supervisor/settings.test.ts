import { describe, expect, it } from 'vitest';
import { effectiveAutomationEnabled } from './settings';

describe('effectiveAutomationEnabled', () => {
	it('defaults missing settings to enabled and preserves stored booleans', () => {
		expect(effectiveAutomationEnabled(undefined)).toBe(true);
		expect(effectiveAutomationEnabled(null)).toBe(true);
		expect(effectiveAutomationEnabled(0)).toBe(false);
		expect(effectiveAutomationEnabled(1)).toBe(true);
	});
});
