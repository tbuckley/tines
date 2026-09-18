import { test } from '@playwright/test';
import { d1 } from './d1';
import { spendRearmStatement } from './spend-seed.mjs';

/**
 * The day-relative ledger rows are seeded against the UTC day at *seed* time,
 * but every Spend assertion names a day relative to the clock at *assertion*
 * time, and the API resolves `window=today` against the request clock. A suite
 * that crosses UTC midnight between the two makes them disagree by a day —
 * which is exactly how CI run 34659806292 went red. `armLedgerDays` puts both
 * on one anchor: it first steps past an imminent rollover (so the anchor
 * cannot expire mid-test), rewrites the rows from that anchor, and returns it
 * for `utcDate` to name days from. Every Spend spec shares this one copy; a
 * spec-local reimplementation is how the rollover-margin step went missing
 * from two of them.
 */
const ROLLOVER_MARGIN_MS = 3 * 60 * 1000;

export async function armLedgerDays(): Promise<number> {
	const untilMidnight = 86_400_000 - (Date.now() % 86_400_000);
	if (untilMidnight < ROLLOVER_MARGIN_MS) {
		test.setTimeout(Math.max(test.info().timeout, untilMidnight + 90_000));
		await new Promise((resolve) => setTimeout(resolve, untilMidnight + 1_000));
	}
	const anchor = Date.now();
	d1(spendRearmStatement(anchor));
	return anchor;
}

/** The UTC day `offsetDays` from the anchor `armLedgerDays` returned. */
export function utcDate(offsetDays: number, anchor: number) {
	const date = new Date(anchor);
	date.setUTCHours(0, 0, 0, 0);
	date.setUTCDate(date.getUTCDate() + offsetDays);
	return date.toISOString().slice(0, 10);
}
