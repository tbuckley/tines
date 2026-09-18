/**
 * Shared formatting for the flow board's "This week" row, so the table on
 * `/agents` and `tines supervisor stats` print identical numbers (Tines/257).
 * No colour and no judgement here: a rise in one figure is good and in
 * another is bad, and the board does not decide which.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A duration in ms as the board prints it: "42 min", "3.1 h", "2.4 d". */
export function durationLabel(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < MIN) return `${Math.round(ms / 1000)} s`;
	if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
	if (ms < DAY) return `${(ms / HOUR).toFixed(1)} h`;
	return `${(ms / DAY).toFixed(1)} d`;
}

export function shareLabel(share: number | null | undefined): string {
	if (share === null || share === undefined) return '—';
	return `${Math.round(share * 100)}%`;
}

/**
 * The change marker beside a figure. `null` (unmeasured on either side, or
 * `compare=none`) prints nothing at all rather than a zero, and an exact zero
 * prints "=" — "no change" and "not comparable" are different answers.
 */
export function deltaLabel(
	delta: number | null | undefined,
	kind: 'ms' | 'count' | 'share' | 'ratio'
): string {
	if (delta === null || delta === undefined) return '';
	if (delta === 0) return '=';
	const arrow = delta > 0 ? '▲' : '▼';
	const size = Math.abs(delta);
	switch (kind) {
		case 'ms':
			return `${arrow} ${durationLabel(size)}`;
		case 'share':
			return `${arrow} ${Math.round(size * 100)} pp`;
		case 'ratio':
			return `${arrow} ${size.toFixed(1)}`;
		default:
			return `${arrow} ${size}`;
	}
}
