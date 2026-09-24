import type { AnalyticsEngineDataPoint } from '@cloudflare/workers-types';
import { LOADING_STATES } from '$lib/perf/loading-states';
import { MAX_RECORDS_PER_BATCH, type TelemetryRecord } from '$lib/perf/telemetry';

/**
 * Validation and storage for real-user latency telemetry (lib/perf/telemetry.ts).
 * Rows go to Workers Analytics Engine (the `PERF` binding), never D1: a write
 * costs no D1 round trip and cannot contend with the app's own writes.
 *
 * Row layout, read by `scripts/perf-report.mjs` — change both together:
 * - index1: kind (`nav` | `loading`)
 * - blob1: route id, blob2: from route (nav) or loading-state id (loading),
 *   blob3: navigation type, blob4: viewport, blob5: colo, blob6: country,
 *   blob7: deployment version
 * - double1: ms, double2: wait, double3: server app, double4: server auth,
 *   double5: preloaded (0/1)
 */
export const MAX_BODY_BYTES = 32 * 1024;
const ROUTE = /^[\w\-./()[\]=+@]{0,200}$/;
const NAV_TYPES = new Set(['link', 'goto', 'popstate', 'form', 'enter']);
/** Anything slower than a minute is a backgrounded tab, not a navigation. */
const MAX_MS = 60_000;

const ms = (v: unknown, min = 0) =>
	typeof v === 'number' && Number.isFinite(v) && v >= min && v <= MAX_MS ? Math.round(v) : null;

export function parseTelemetry(body: unknown): TelemetryRecord[] {
	const records = (body as { records?: unknown })?.records;
	if (!Array.isArray(records)) return [];
	const out: TelemetryRecord[] = [];
	for (const r of records.slice(0, MAX_RECORDS_PER_BATCH)) {
		if (!r || typeof r !== 'object') continue;
		const x = r as Record<string, unknown>;
		if (typeof x.route !== 'string' || !ROUTE.test(x.route)) continue;
		const duration = ms(x.ms);
		if (duration === null) continue;
		if (x.k === 'nav') {
			if (typeof x.from !== 'string' || !ROUTE.test(x.from)) continue;
			if (typeof x.type !== 'string' || !NAV_TYPES.has(x.type)) continue;
			out.push({
				k: 'nav',
				route: x.route,
				from: x.from,
				type: x.type,
				ms: duration,
				wait: ms(x.wait, -1) ?? -1,
				app: ms(x.app, -1) ?? -1,
				auth: ms(x.auth, -1) ?? -1,
				pre: x.pre === 1 ? 1 : 0,
				vp: x.vp === 'phone' ? 'phone' : 'desktop'
			});
		} else if (x.k === 'loading') {
			if (typeof x.id !== 'string' || !(x.id in LOADING_STATES)) continue;
			out.push({
				k: 'loading',
				id: x.id as keyof typeof LOADING_STATES,
				route: x.route,
				ms: duration
			});
		}
	}
	return out;
}

export type TelemetryContext = { colo: string; country: string; version: string };

export function toDataPoint(r: TelemetryRecord, ctx: TelemetryContext): AnalyticsEngineDataPoint {
	return r.k === 'nav'
		? {
				indexes: ['nav'],
				blobs: [r.route, r.from, r.type, r.vp, ctx.colo, ctx.country, ctx.version],
				doubles: [r.ms, r.wait, r.app, r.auth, r.pre]
			}
		: {
				indexes: ['loading'],
				blobs: [r.route, r.id, '', '', ctx.colo, ctx.country, ctx.version],
				doubles: [r.ms, -1, -1, -1, 0]
			};
}
