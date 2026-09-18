import { describe, expect, it } from 'vitest';
import type { StageStats, StageStatsReport, StageWindowFigures } from '@tines/shared';
import {
	comparisonText,
	markersForState,
	selectStageHighlights,
	stageControlsHref,
	stageDetailComparisons,
	stageRunsHref
} from './stage-stats-view';
const empty: StageWindowFigures = {
	since: 100,
	until: 200,
	visits: 0,
	exits: 0,
	queue_wait: null,
	queue_wait_measured: 0,
	waiting_now: 0,
	never_started: 0,
	work: null,
	work_measured: 0,
	open_now: 0,
	runs: {
		total: 0,
		per_visit: null,
		active: 0,
		unbound: 0,
		recovered_advanced: 0,
		outcomes: { advanced: 0, stalled: 0, failed: 0, interrupted: 0, unrecorded: 0 },
		top_runner: null
	},
	sent_back: { count: 0, share: null, agent: 0, human: 0, by_target: [] },
	received_back: 0,
	cost: null
};
function stage(name: string): StageStats {
	return {
		state_id: name,
		state_name: name,
		workflow_id: 'wf',
		workflow_name: 'Engineering',
		current: structuredClone(empty),
		previous: structuredClone(empty),
		delta: {
			visits: 0,
			exits: 0,
			queue_wait_p50: null,
			queue_wait_p90: null,
			work_p50: null,
			work_p90: null,
			runs_per_visit: null,
			sent_back_share: null,
			outcomes: { advanced: null, stalled: null, failed: null, interrupted: null, unrecorded: null }
		}
	};
}
function report(states: StageStats[]): StageStatsReport {
	return {
		generated_at: 200,
		window: { ms: 100, since: 100, until: 200 },
		previous: { since: 0, until: 100 },
		project: null,
		outcome_recorded_since: 0,
		states,
		markers: []
	};
}
describe('weekly highlights', () => {
	it('selects measured wait and event counts rather than noisy shares', () => {
		const research = stage('Research'),
			review = stage('Automated Review'),
			discover = stage('Discovering'),
			small = stage('One exit');
		research.current.queue_wait = { n: 12, p50: 100, p90: 300, total: 1000 };
		research.current.queue_wait_measured = 12;
		review.current.exits = 55;
		review.current.sent_back = { count: 11, share: 0.2, agent: 11, human: 0, by_target: [] };
		discover.current.runs.total = 20;
		discover.current.runs.outcomes.failed = 11;
		small.current.exits = 1;
		small.current.sent_back.count = 1;
		small.current.sent_back.share = 1;
		expect(
			selectStageHighlights(report([small, discover, research, review])).map((h) => [
				h.kind,
				h.stage.state_id,
				h.detail
			])
		).toEqual([
			['timing', 'Research', '1 s across 12 timed visits'],
			['sent', 'Automated Review', '11 of 55 exits · 20%'],
			['runs', 'Discovering', '11 of 20 runs failed to start']
		]);
		expect(selectStageHighlights(report([small]))).toHaveLength(1);
	});
	it('uses stable ties, allows one stage in multiple categories, omits zero/null and previous-only observations', () => {
		const b = stage('B'),
			a = stage('A'),
			old = stage('Old');
		for (const s of [a, b]) {
			s.current.sent_back.count = 2;
			s.current.runs.outcomes.failed = 3;
		}
		old.previous!.sent_back.count = 100;
		const selected = selectStageHighlights(report([b, old, a]));
		expect(selected.map((h) => h.stage.state_id)).toEqual(['A', 'A']);
		expect(selected.every((h) => h.label.includes('joint most'))).toBe(true);
		expect(selectStageHighlights(report([old]))).toEqual([]);
	});
});
describe('readable comparisons', () => {
	it('uses percentage points and distinguishes equal, missing and tiny observations', () => {
		expect(comparisonText(0.2, 0.09, 'share')).toBe('↑ Up 11 pp · was 9%');
		expect(comparisonText(0, 0, 'count')).toBe('No change · was 0');
		expect(comparisonText(null, 3, 'count')).toBe('Not comparable · was 3');
		expect(comparisonText(0, null, 'count')).toBe('No previous data');
		expect(comparisonText(0, 3, 'count', false)).toBe('');
		expect(comparisonText(0.101, 0.1, 'share')).toContain('Less than 1 pp');
		expect(comparisonText(1.01, 1, 'ratio')).toContain('Less than 0.1');
		expect(comparisonText(1001, 1000, 'ms')).toContain('Less than 1 s');
	});
	it('unions previous targets and suppresses unknown outcome coverage', () => {
		const s = stage('Review');
		s.previous!.sent_back.by_target = [
			{ state_id: 'gone', state_name: 'Old target', count: 3, agent: 2, human: 1 }
		];
		s.current.runs.outcomes.failed = 2;
		s.previous!.runs.outcomes.failed = 5;
		const r = report([s]);
		r.outcome_recorded_since = null;
		const rows = stageDetailComparisons(s, r);
		expect(rows.sent.find((row) => row.label === 'To Old target · total')).toMatchObject({
			current: '0',
			previous: '3',
			change: '↓ Down 3 · was 3'
		});
		expect(rows.runs.find((row) => row.label === 'Failed to start')).toMatchObject({
			current: '2',
			previous: '5',
			change: 'Recording incomplete'
		});
		expect(rows.timing.find((row) => row.label === 'Queue wait median')?.current).toBe(
			'Not measured'
		);
	});
	it('preserves explicit project and unrelated URL state when selecting or clearing runs', () => {
		const url = new URL('https://example.test/agents?project=P&foo=x&runs_state=old#runners');
		expect(stageRunsHref(url, 'new')).toBe('/agents?project=P&foo=x&runs_state=new#runs');
		expect(stageRunsHref(url, null)).toBe('/agents?project=P&foo=x#runs');
		url.searchParams.set('agents_view', 'spend');
		url.searchParams.set('spend_project', 'different');
		expect(stageRunsHref(url, 'new')).toBe(
			'/agents?project=P&foo=x&runs_state=new&spend_project=different#runs'
		);
		expect(url.hash).toBe('#runners');
	});
	it('moves analysis links to Now controls without mutating independent scopes', () => {
		const url = new URL(
			'https://example.test/agents?agents_view=spend&project=board&spend_project=spend&runs_state=state&foo=x#this-week'
		);
		expect(stageControlsHref(url, 'runners')).toBe(
			'/agents?project=board&spend_project=spend&runs_state=state&foo=x#runners'
		);
		expect(stageControlsHref(url, 'routing')).toBe(
			'/agents?project=board&spend_project=spend&runs_state=state&foo=x#routing'
		);
		expect(stageControlsHref(url, 'quota-policy')).toBe(
			'/agents?project=board&spend_project=spend&runs_state=state&foo=x#quota-policy'
		);
		expect(url.searchParams.get('agents_view')).toBe('spend');
		expect(url.hash).toBe('#this-week');
	});
	it('keeps global markers and only the affected stage markers', () => {
		const r = report([]);
		const base = { at: 150, kind: 'rule' as const, label: 'Rule', event_ids: [], effects: [] };
		r.markers = [
			{ ...base, id: 'global', state_ids: [] },
			{ ...base, id: 'A', state_ids: ['a'] },
			{ ...base, id: 'B', state_ids: ['b'] }
		];
		expect(markersForState(r, 'a').map((m) => m.id)).toEqual(['global', 'A']);
	});
});
