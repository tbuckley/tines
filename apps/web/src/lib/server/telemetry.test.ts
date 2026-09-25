import { describe, expect, it } from 'vitest';
import { parseTelemetry, toDataPoint } from './telemetry';

const nav = {
	k: 'nav',
	route: '/(app)/issues/[project]/[number]',
	from: '/(app)/issues',
	type: 'link',
	ms: 123.4,
	wait: 80,
	app: 41.2,
	auth: 0,
	pre: 1,
	vp: 'phone'
};

describe('parseTelemetry', () => {
	it('keeps well-formed navigation and loading records, rounded', () => {
		const out = parseTelemetry({
			records: [nav, { k: 'loading', id: 'issue.agent-activity', route: nav.route, ms: 250.6 }]
		});
		expect(out).toEqual([
			{ ...nav, ms: 123, app: 41 },
			{ k: 'loading', id: 'issue.agent-activity', route: nav.route, ms: 251 }
		]);
	});

	it('drops what is malformed, unregistered or implausible, and keeps the rest', () => {
		const out = parseTelemetry({
			records: [
				{ ...nav, route: 'https://evil.example/<script>' },
				{ ...nav, type: 'teleport' },
				{ ...nav, ms: -1 },
				{ ...nav, ms: 10 * 60_000 },
				{ ...nav, ms: 'fast' },
				{ k: 'loading', id: 'not.registered', route: '/', ms: 5 },
				{ k: 'other', route: '/', ms: 5 },
				null,
				nav
			]
		});
		expect(out).toHaveLength(1);
	});

	it('normalises optional fields instead of trusting them', () => {
		const [r] = parseTelemetry({ records: [{ ...nav, wait: 'x', pre: 'yes', vp: 'tv' }] });
		expect(r).toMatchObject({ wait: -1, pre: 0, vp: 'desktop' });
	});

	it('caps a batch and ignores bodies without records', () => {
		expect(parseTelemetry({ records: Array(500).fill(nav) })).toHaveLength(50);
		expect(parseTelemetry(null)).toEqual([]);
		expect(parseTelemetry({ records: 'x' })).toEqual([]);
	});
});

describe('toDataPoint', () => {
	it('lays out a navigation row as perf-report.mjs reads it', () => {
		const [r] = parseTelemetry({ records: [nav] });
		expect(toDataPoint(r, { colo: 'LHR', country: 'GB', version: 'v1' })).toEqual({
			indexes: ['nav'],
			blobs: [nav.route, nav.from, 'link', 'phone', 'LHR', 'GB', 'v1'],
			doubles: [123, 80, 41, 0, 1]
		});
	});
});
