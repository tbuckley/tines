/**
 * Real-user latency telemetry (docs/PERFORMANCE.md, "Real users"): how long
 * each in-app navigation takes from the click to the new page on screen, and
 * how long each registered loading state stays up. Records are queued and
 * sent in batches with `sendBeacon`, so reporting never competes with a
 * navigation for the network. The server side is `routes/api/telemetry`.
 *
 * Only route ids are recorded, never URLs: `/issues/[project]/[number]`, not
 * which issue.
 */
import type { LoadingStateId } from './loading-states';

export type NavigationRecord = {
	k: 'nav';
	/** Route id navigated to, e.g. `/(app)/issues/[project]/[number]`. */
	route: string;
	/** Route id navigated from (empty on the first load). */
	from: string;
	/** SvelteKit navigation type: link, goto, popstate, form, enter. */
	type: string;
	/** Click (or history event) to the new page mounted, ms. For `enter`, time since the document request started. */
	ms: number;
	/** How long the navigation waited on its `__data.json` after it began, ms (0 when the preload had already landed; -1 when no data request was made). */
	wait: number;
	/** Server-Timing `app` and `auth` of that data request, ms (-1 when unknown). */
	app: number;
	auth: number;
	/** 1 when the data request started before the click (a hover or touch preload). */
	pre: 0 | 1;
	/** Viewport class at the time: `phone` below 48rem, else `desktop`. */
	vp: 'phone' | 'desktop';
};

export type LoadingRecord = {
	k: 'loading';
	id: LoadingStateId;
	route: string;
	/** How long the loading state was on screen, ms. */
	ms: number;
};

export type TelemetryRecord = NavigationRecord | LoadingRecord;

export const TELEMETRY_ENDPOINT = '/api/telemetry';
export const MAX_RECORDS_PER_BATCH = 50;
const FLUSH_INTERVAL_MS = 10_000;

const queue: TelemetryRecord[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function flush() {
	if (timer) clearTimeout(timer);
	timer = null;
	while (queue.length) {
		const batch = queue.splice(0, MAX_RECORDS_PER_BATCH);
		try {
			const blob = new Blob([JSON.stringify({ records: batch })], { type: 'application/json' });
			if (!navigator.sendBeacon?.(TELEMETRY_ENDPOINT, blob))
				void fetch(TELEMETRY_ENDPOINT, { method: 'POST', body: blob, keepalive: true }).catch(
					() => {}
				);
		} catch {
			// Telemetry must never break the page.
		}
	}
}

export function record(entry: TelemetryRecord) {
	if (typeof window === 'undefined') return;
	if (!listening) {
		listening = true;
		addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') flush();
		});
		addEventListener('pagehide', flush);
	}
	queue.push(entry);
	if (queue.length >= MAX_RECORDS_PER_BATCH) flush();
	else timer ??= setTimeout(flush, FLUSH_INTERVAL_MS);
}

export function viewportClass(): 'phone' | 'desktop' {
	return typeof matchMedia === 'function' && matchMedia('(width < 48rem)').matches
		? 'phone'
		: 'desktop';
}

/**
 * The data request a navigation to `pathname` used, read from Resource
 * Timing: the latest `__data.json` for that path. It may have started before
 * `startedAt` (a preload), in which case the navigation only waited for
 * whatever of it was still in flight.
 *
 * It then clears the Resource Timing buffer, so the next navigation can only
 * find its own request. Without that, a navigation whose request had not
 * finished by mount (a streamed page like the issue page adds its entry only
 * when the stream ends) picked up the same path's request from an earlier
 * visit and reported `wait` 0 with that request's server time. It now
 * reports -1 (unknown) instead. The buffer also stops recording at 250
 * entries by default, which a tab left open all day reaches.
 */
export function dataTiming(pathname: string, startedAt: number) {
	const none = { wait: -1, app: -1, auth: -1, pre: 0 as 0 | 1 };
	if (typeof performance === 'undefined' || !performance.getEntriesByType) return none;
	const suffix = `${pathname.replace(/\/$/, '')}/__data.json`;
	const entries = performance
		.getEntriesByType('resource')
		.filter((e) => new URL(e.name).pathname === suffix) as PerformanceResourceTiming[];
	performance.clearResourceTimings?.();
	const entry = entries[entries.length - 1];
	if (!entry) return none;
	const server = (name: string) => entry.serverTiming?.find((t) => t.name === name)?.duration ?? -1;
	return {
		wait: Math.max(0, entry.responseEnd - startedAt),
		app: server('app'),
		auth: server('auth'),
		pre: (entry.startTime < startedAt ? 1 : 0) as 0 | 1
	};
}
