import {
	durationLabel,
	shareLabel,
	type StageStats,
	type StageStatsReport,
	type StageWindowFigures
} from '@tines/shared';

export type MeasureKind = 'ms' | 'share' | 'ratio' | 'count';
export const measureLabel = (value: number | null | undefined, kind: MeasureKind): string =>
	value == null
		? kind === 'share'
			? 'No exits'
			: kind === 'ratio'
				? 'No visits'
				: 'Not measured'
		: kind === 'ms'
			? durationLabel(value)
			: kind === 'share'
				? shareLabel(value)
				: kind === 'ratio'
					? value.toFixed(1)
					: String(value);
export function comparisonText(
	current: number | null | undefined,
	previous: number | null | undefined,
	kind: MeasureKind,
	compare = true
): string {
	if (!compare) return '';
	if (previous == null) return 'No previous data';
	const was = `was ${measureLabel(previous, kind)}`;
	if (current == null) return `Not comparable · ${was}`;
	const delta = current - previous;
	if (delta === 0) return `No change · ${was}`;
	const size = Math.abs(delta);
	const magnitude =
		kind === 'share'
			? size < 0.01
				? 'Less than 1 pp'
				: `${Math.round(size * 100)} pp`
			: kind === 'ratio'
				? size < 0.1
					? 'Less than 0.1'
					: size.toFixed(1)
				: kind === 'ms'
					? size < 1000
						? 'Less than 1 s'
						: durationLabel(size)
					: String(size);
	return `${delta > 0 ? '↑ Up' : '↓ Down'} ${magnitude} · ${was}`;
}
export function selectStageHighlights(report: StageStatsReport) {
	const definitions = [
		{
			kind: 'timing',
			label: 'Most measured wait',
			value: (s: StageStats) => s.current.queue_wait?.total ?? 0,
			detail: (s: StageStats) =>
				`${durationLabel(s.current.queue_wait?.total)} across ${s.current.queue_wait_measured} timed visits`
		},
		{
			kind: 'sent',
			label: 'Most send-backs',
			value: (s: StageStats) => s.current.sent_back.count,
			detail: (s: StageStats) =>
				`${s.current.sent_back.count} of ${s.current.exits} exits · ${shareLabel(s.current.sent_back.share)}`
		},
		{
			kind: 'runs',
			label: 'Most failed starts',
			value: (s: StageStats) => s.current.runs.outcomes.failed,
			detail: (s: StageStats) =>
				`${s.current.runs.outcomes.failed} of ${s.current.runs.total} runs failed to start`
		}
	] as const;
	return definitions.flatMap((d) => {
		const rows = report.states
			.filter((s) => d.value(s) > 0)
			.sort(
				(a, b) =>
					d.value(b) - d.value(a) ||
					a.workflow_name.localeCompare(b.workflow_name) ||
					a.state_name.localeCompare(b.state_name) ||
					a.state_id.localeCompare(b.state_id)
			);
		if (!rows.length) return [];
		const stage = rows[0];
		return [
			{
				kind: d.kind,
				label: d.label + (rows[1] && d.value(rows[1]) === d.value(stage) ? ' · joint most' : ''),
				stage,
				detail: d.detail(stage)
			}
		];
	});
}
export function markersForState(report: StageStatsReport, id: string) {
	return report.markers.filter(
		(m) =>
			!m.state_ids.length || m.state_ids.includes(id) || m.effects.some((e) => e.state_id === id)
	);
}
export function stageRunsHref(currentUrl: URL, stateId: string | null) {
	const url = new URL(currentUrl);
	url.searchParams.delete('agents_view');
	if (stateId) url.searchParams.set('runs_state', stateId);
	else url.searchParams.delete('runs_state');
	url.hash = 'runs';
	return `${url.pathname}${url.search}${url.hash}`;
}
export function stageControlsHref(currentUrl: URL, target: 'runners' | 'routing' | 'quota-policy') {
	const url = new URL(currentUrl);
	url.searchParams.delete('agents_view');
	url.hash = target;
	return `${url.pathname}${url.search}${url.hash}`;
}
export const workflowHref = (stage: StageStats) =>
	`/workflows/${stage.workflow_id}?state=${stage.state_id}#state-${stage.state_id}`;
export function stageDetailComparisons(stage: StageStats, report: StageStatsReport) {
	const row = (
		label: string,
		get: (f: StageWindowFigures) => number | null | undefined,
		kind: MeasureKind = 'count',
		outcome = false
	) => {
		const current = get(stage.current),
			previous = stage.previous ? get(stage.previous) : null;
		const incomplete =
			outcome &&
			(report.outcome_recorded_since === null ||
				!stage.previous ||
				stage.previous.since < report.outcome_recorded_since);
		return {
			label,
			current: measureLabel(current, kind),
			previous: stage.previous ? measureLabel(previous, kind) : 'No previous data',
			change: incomplete
				? 'Recording incomplete'
				: comparisonText(current, previous, kind, report.previous !== null)
		};
	};
	const timing = [
		row('Entries (visits)', (f) => f.visits),
		row('Exits', (f) => f.exits),
		...(['queue_wait', 'work'] as const).flatMap((key) =>
			(['p50', 'p90', 'total'] as const).map((stat) =>
				row(
					`${key === 'queue_wait' ? 'Queue wait' : 'Work time'} ${stat === 'p50' ? 'median' : stat === 'p90' ? 'p90' : 'total'}`,
					(f) => f[key]?.[stat],
					'ms'
				)
			)
		),
		row('Timed queue visits', (f) => f.queue_wait_measured),
		row('Timed work visits', (f) => f.work_measured),
		row('Still waiting (not timed)', (f) => f.waiting_now),
		row('Closed without starting', (f) => f.never_started),
		row('Open after starting', (f) => f.open_now)
	];
	const runs = [
		row('Bound runs', (f) => f.runs.total),
		row('Runs per visit', (f) => f.runs.per_visit, 'ratio'),
		row('Active runs', (f) => f.runs.active),
		row('Unbound runs', (f) => f.runs.unbound),
		...(['advanced', 'stalled', 'failed', 'interrupted', 'unrecorded'] as const).map((key) =>
			row(
				key === 'failed' ? 'Failed to start' : key[0].toUpperCase() + key.slice(1),
				(f) => f.runs.outcomes[key],
				'count',
				true
			)
		),
		row('Recovered advanced', (f) => f.runs.recovered_advanced, 'count', true)
	];
	const sent = [
		row('Sent back', (f) => f.sent_back.count),
		row('Share of exits', (f) => f.sent_back.share, 'share'),
		row('Exits', (f) => f.exits),
		row('By agents', (f) => f.sent_back.agent),
		row('By humans', (f) => f.sent_back.human),
		row('Received back', (f) => f.received_back)
	];
	const targets = new Map(
		[...stage.current.sent_back.by_target, ...(stage.previous?.sent_back.by_target ?? [])].map(
			(t) => [t.state_id, t.state_name]
		)
	);
	for (const [id, name] of targets)
		for (const key of ['count', 'agent', 'human'] as const)
			sent.push(
				row(
					`To ${name} · ${key === 'count' ? 'total' : key + 's'}`,
					(f) => f.sent_back.by_target.find((t) => t.state_id === id)?.[key] ?? 0
				)
			);
	return { timing, runs, sent };
}
