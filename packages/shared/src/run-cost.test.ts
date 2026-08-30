import { describe, expect, it } from 'vitest';
import { runCostLabel } from './types.js';

// Moved out of the CLI and the Agents tab, which had diverged only in their
// fallback: the CLI printed '—', the web hid the cell. Shared returns null and
// the CLI applies `?? '—'`.
describe('runCostLabel', () => {
	it('returns null when the run reported no usage at all', () => {
		expect(runCostLabel({ usage: undefined } as never)).toBeNull();
	});

	it('prefers dollars, to two places', () => {
		expect(runCostLabel({ usage: { cost_usd: 1.5 } } as never)).toBe('$1.50');
		expect(runCostLabel({ usage: { cost_usd: 0 } } as never)).toBe('$0.00');
		expect(runCostLabel({ usage: { cost_usd: 12.345 } } as never)).toBe('$12.35');
	});

	it("says so when the harness reports no cost source", () => {
		expect(runCostLabel({ usage: { cost_source: 'none' } } as never)).toBe('unreported');
	});

	it('falls back to summed tokens, thousands-separated', () => {
		expect(runCostLabel({ usage: { input_tokens: 1000, output_tokens: 234 } } as never)).toBe(
			'1,234 tok'
		);
	});

	it('returns null rather than "0 tok" when there is nothing to report', () => {
		expect(runCostLabel({ usage: { input_tokens: 0, output_tokens: 0 } } as never)).toBeNull();
	});
});
