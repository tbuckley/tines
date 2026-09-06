import {
	ACTIVE_RUN_STATUSES,
	RUN_OUTCOME_BUCKETS,
	type DurationStats,
	type RunEndOutcome,
	type RunOutcomeBucket,
	type StageStats,
	type StageStatsDelta,
	type StageStatsReport,
	type StageWindowFigures,
	type StateCategory
} from '@tines/shared';

/**
 * The flow board's "This week" row, computed on request from the events and
 * runs already stored (Tines/257). Pure: the loader in `api/supervisor.ts`
 * does the reads and the JSON parsing, this module does the arithmetic, so
 * the PRD's hand-computed figures are a function test rather than a fixture
 * database (the shape `logic.ts` set for the Now row).
 */

export interface StatsStateMeta {
	id: string;
	name: string;
	workflow_id: string;
	workflow_name: string;
	category: StateCategory;
	position: number;
}

/** An entry-or-exit event, payload already parsed by the loader. */
export interface StatsEvent {
	id: string;
	type: 'issue.transitioned' | 'issue.created' | 'issue.updated';
	issue_id: string;
	created_at: number;
	actor_api_key_id: string | null;
	/** True when the actor key is a run key — the agent/human split. */
	actor_is_run: boolean;
	from_state_id: string | null;
	to_state_id: string | null;
}

export interface StatsRun {
	id: string;
	issue_id: string;
	runner_id: string;
	runner_name: string;
	status: string;
	outcome: RunEndOutcome | null;
	state_id_at_start: string;
	api_key_id: string | null;
	created_at: number;
	started_at: number | null;
	ended_at: number | null;
}

export interface StatsInput {
	now: number;
	windowMs: number;
	/** False for `compare=none`: no previous figures, no deltas. */
	compare: boolean;
	states: StatsStateMeta[];
	events: StatsEvent[];
	runs: StatsRun[];
	/** Run key ids that authored a transition — how a pre-0016 run is judged `advanced`. */
	advancedByKey: Set<string>;
	outcomeRecordedSince: number | null;
	project: { id: string; name: string } | null;
}

/** `[entry, exit)` for one issue in one state. */
export interface Visit {
	id: string;
	issue_id: string;
	state_id: string;
	entered_at: number;
	/** Null while the issue is still in the state. */
	exited_at: number | null;
	/** The exit's target, null when open or when the exit left the workflow. */
	to_state_id: string | null;
	/** True when the exit went backwards (see `isSentBack`). */
	sent_back: boolean;
	/** Who transitioned it out. */
	exit_actor: 'agent' | 'human' | null;
	/**
	 * The entry predates the scan, so the visit's clock cannot be measured —
	 * its exit still counts, its durations do not.
	 */
	unbounded: boolean;
}

// ---------------------------------------------------------------------------
// Percentiles

/** Nearest-rank, the definition the PRD's hand figures use. */
export function percentile(xs: number[], p: number): number | null {
	if (xs.length === 0) return null;
	const sorted = [...xs].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export function median(xs: number[]): number | null {
	return percentile(xs, 50);
}

export function durationStats(xs: number[]): DurationStats | null {
	if (xs.length === 0) return null;
	return {
		p50: median(xs) as number,
		p90: percentile(xs, 90) as number,
		total: xs.reduce((a, b) => a + b, 0),
		n: xs.length
	};
}

// ---------------------------------------------------------------------------
// Visits

/**
 * Builds the per-issue state timeline. An entry is a transition's target, a
 * created issue's state, or a workflow change's new state; the next entry for
 * the same issue closes the previous visit. Events are assumed to arrive
 * ordered by `(created_at, id)`; ties keep insertion order.
 */
export function buildVisits(events: StatsEvent[], states: Map<string, StatsStateMeta>): Visit[] {
	const byIssue = new Map<string, StatsEvent[]>();
	for (const ev of events) {
		if (!ev.to_state_id) continue;
		const list = byIssue.get(ev.issue_id);
		if (list) list.push(ev);
		else byIssue.set(ev.issue_id, [ev]);
	}
	const visits: Visit[] = [];
	for (const [issueId, list] of byIssue) {
		list.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		let open: Visit | null = null;
		for (const ev of list) {
			if (open) {
				open.exited_at = ev.created_at;
				open.to_state_id = ev.to_state_id;
				open.sent_back = isSentBack(open.state_id, ev.to_state_id, states);
				open.exit_actor = ev.actor_is_run ? 'agent' : 'human';
			}
			// An event whose `from_state_id` disagrees with the open visit is
			// still an entry: the timeline follows the issue, not the payload.
			open = {
				id: `${issueId}:${ev.id}`,
				issue_id: issueId,
				state_id: ev.to_state_id as string,
				entered_at: ev.created_at,
				exited_at: null,
				to_state_id: null,
				sent_back: false,
				exit_actor: null,
				unbounded: false
			};
			visits.push(open);
		}
	}
	// Anything whose `from_state_id` names a state we never saw entered opened
	// before the scan: reconstruct it so its exit is still counted.
	for (const ev of events) {
		if (!ev.from_state_id) continue;
		const covers = visits.some(
			(v) =>
				v.issue_id === ev.issue_id &&
				v.state_id === ev.from_state_id &&
				v.entered_at <= ev.created_at &&
				(v.exited_at === null || v.exited_at >= ev.created_at)
		);
		if (covers) continue;
		visits.push({
			id: `${ev.issue_id}:pre:${ev.id}`,
			issue_id: ev.issue_id,
			state_id: ev.from_state_id,
			entered_at: -Infinity,
			exited_at: ev.created_at,
			to_state_id: ev.to_state_id,
			sent_back: isSentBack(ev.from_state_id, ev.to_state_id, states),
			exit_actor: ev.actor_is_run ? 'agent' : 'human',
			unbounded: true
		});
	}
	return visits;
}

/**
 * An exit is "sent back" when its target sits earlier in the same workflow's
 * state order and is not a done state — the approved definition on Tines/200.
 * A workflow change is never a sent-back: the orders are not comparable.
 */
export function isSentBack(
	fromStateId: string,
	toStateId: string | null,
	states: Map<string, StatsStateMeta>
): boolean {
	if (!toStateId) return false;
	const from = states.get(fromStateId);
	const to = states.get(toStateId);
	if (!from || !to) return false;
	if (from.workflow_id !== to.workflow_id) return false;
	if (to.category === 'done') return false;
	return to.position < from.position;
}

// ---------------------------------------------------------------------------
// Runs

/**
 * Binds each run to the visit its claim time falls inside — never to the state
 * alone, or an issue that ping-pongs A→B→A reports both visits' runs against
 * both. Runs whose visit is unknown (deleted issue, or a visit that opened
 * before the scan) are returned as `unbound` and counted per state only.
 */
export function bindRuns(
	visits: Visit[],
	runs: StatsRun[]
): { bound: Map<string, StatsRun[]>; unbound: StatsRun[] } {
	const byIssue = new Map<string, Visit[]>();
	for (const v of visits) {
		const list = byIssue.get(v.issue_id);
		if (list) list.push(v);
		else byIssue.set(v.issue_id, [v]);
	}
	const bound = new Map<string, StatsRun[]>();
	const unbound: StatsRun[] = [];
	for (const run of runs) {
		const candidates = byIssue.get(run.issue_id) ?? [];
		const visit = candidates.find(
			(v) =>
				!v.unbounded &&
				v.state_id === run.state_id_at_start &&
				v.entered_at <= run.created_at &&
				(v.exited_at === null || run.created_at < v.exited_at)
		);
		if (!visit) {
			unbound.push(run);
			continue;
		}
		const list = bound.get(visit.id);
		if (list) list.push(run);
		else bound.set(visit.id, [run]);
	}
	return { bound, unbound };
}

/**
 * The outcome column's bucket. A run that never started is a launch failure
 * (`failed`) whatever its status says; a row with no stored outcome is
 * `unrecorded` unless its own key authored a transition, the rule `endRun`
 * applies live.
 */
export function bucketOutcome(
	run: StatsRun,
	advancedByKey: Set<string>
): RunOutcomeBucket | 'active' {
	if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return 'active';
	if (run.started_at === null) return 'failed';
	if (run.outcome) return run.outcome;
	if (run.api_key_id && advancedByKey.has(run.api_key_id)) return 'advanced';
	return 'unrecorded';
}

function emptyOutcomes(): Record<RunOutcomeBucket, number> {
	return Object.fromEntries(RUN_OUTCOME_BUCKETS.map((b) => [b, 0])) as Record<
		RunOutcomeBucket,
		number
	>;
}

// ---------------------------------------------------------------------------
// Per-state figures

export interface FiguresContext {
	visits: Visit[];
	bound: Map<string, StatsRun[]>;
	unbound: StatsRun[];
	states: Map<string, StatsStateMeta>;
	advancedByKey: Set<string>;
	now: number;
}

/**
 * One state's figures over `[since, until)`. Visit-based figures count visits
 * that *entered* in the window; exit-based ones count exits that happened in
 * it, so the sent-back share is over exits and never exceeds 1.
 */
export function stageFigures(
	stateId: string,
	ctx: FiguresContext,
	since: number,
	until: number
): StageWindowFigures {
	const inWindow = (t: number) => t >= since && t < until;
	const mine = ctx.visits.filter((v) => v.state_id === stateId);
	const entered = mine.filter((v) => !v.unbounded && inWindow(v.entered_at));
	const exited = mine.filter((v) => v.exited_at !== null && inWindow(v.exited_at));

	const queueWaits: number[] = [];
	const workTimes: number[] = [];
	let waitingNow = 0;
	let neverStarted = 0;
	let openNow = 0;
	let runsTotal = 0;
	let active = 0;
	let recovered = 0;
	let visitsWithRuns = 0;
	const outcomes = emptyOutcomes();
	const runnerCounts = new Map<string, { id: string; name: string; runs: number }>();

	for (const visit of entered) {
		const runs = (ctx.bound.get(visit.id) ?? [])
			.slice()
			.sort((a, b) => a.created_at - b.created_at);
		if (runs.length > 0) visitsWithRuns++;
		runsTotal += runs.length;
		for (const run of runs) {
			const bucket = bucketOutcome(run, ctx.advancedByKey);
			if (bucket === 'active') active++;
			else {
				outcomes[bucket]++;
				if (bucket === 'advanced' && !run.outcome) recovered++;
			}
			const entry = runnerCounts.get(run.runner_id) ?? {
				id: run.runner_id,
				name: run.runner_name,
				runs: 0
			};
			entry.runs++;
			runnerCounts.set(run.runner_id, entry);
		}
		// A launch failure never started, so it never ends the queue wait.
		const firstStart = runs.find((r) => r.started_at !== null)?.started_at ?? null;
		if (firstStart === null) {
			if (visit.exited_at === null) waitingNow++;
			else neverStarted++;
			continue;
		}
		queueWaits.push(Math.max(0, firstStart - visit.entered_at));
		if (visit.exited_at === null) openNow++;
		else workTimes.push(Math.max(0, visit.exited_at - firstStart));
	}

	const sentBack = exited.filter((v) => v.sent_back);
	const byTarget = new Map<
		string,
		{ state_id: string; state_name: string; count: number; agent: number; human: number }
	>();
	for (const v of sentBack) {
		const target = v.to_state_id as string;
		const entry = byTarget.get(target) ?? {
			state_id: target,
			state_name: ctx.states.get(target)?.name ?? target,
			count: 0,
			agent: 0,
			human: 0
		};
		entry.count++;
		if (v.exit_actor === 'agent') entry.agent++;
		else entry.human++;
		byTarget.set(target, entry);
	}
	const receivedBack = ctx.visits.filter(
		(v) => v.sent_back && v.to_state_id === stateId && v.exited_at !== null && inWindow(v.exited_at)
	).length;

	const unboundHere = ctx.unbound.filter(
		(r) => r.state_id_at_start === stateId && inWindow(r.created_at)
	).length;

	const topRunner = [...runnerCounts.values()].sort(
		(a, b) => b.runs - a.runs || a.name.localeCompare(b.name)
	)[0];

	return {
		since,
		until,
		visits: entered.length,
		exits: exited.length,
		queue_wait: durationStats(queueWaits),
		queue_wait_measured: queueWaits.length,
		waiting_now: waitingNow,
		never_started: neverStarted,
		work: durationStats(workTimes),
		work_measured: workTimes.length,
		open_now: openNow,
		runs: {
			total: runsTotal,
			per_visit: visitsWithRuns > 0 ? runsTotal / visitsWithRuns : null,
			active,
			unbound: unboundHere,
			recovered_advanced: recovered,
			outcomes,
			top_runner: topRunner ?? null
		},
		sent_back: {
			count: sentBack.length,
			share: exited.length > 0 ? sentBack.length / exited.length : null,
			agent: sentBack.filter((v) => v.exit_actor === 'agent').length,
			human: sentBack.filter((v) => v.exit_actor === 'human').length,
			by_target: [...byTarget.values()].sort(
				(a, b) => b.count - a.count || a.state_name.localeCompare(b.state_name)
			)
		},
		received_back: receivedBack,
		cost: null
	};
}

function sub(a: number | null | undefined, b: number | null | undefined): number | null {
	if (a === null || a === undefined || b === null || b === undefined) return null;
	return a - b;
}

function deltaOf(
	current: StageWindowFigures,
	previous: StageWindowFigures | null
): StageStatsDelta {
	const outcomes = Object.fromEntries(
		RUN_OUTCOME_BUCKETS.map((b) => [
			b,
			previous ? current.runs.outcomes[b] - previous.runs.outcomes[b] : null
		])
	) as Record<RunOutcomeBucket, number | null>;
	if (!previous) {
		return {
			visits: null,
			exits: null,
			queue_wait_p50: null,
			queue_wait_p90: null,
			work_p50: null,
			work_p90: null,
			runs_per_visit: null,
			sent_back_share: null,
			outcomes
		};
	}
	return {
		visits: current.visits - previous.visits,
		exits: current.exits - previous.exits,
		queue_wait_p50: sub(current.queue_wait?.p50, previous.queue_wait?.p50),
		queue_wait_p90: sub(current.queue_wait?.p90, previous.queue_wait?.p90),
		work_p50: sub(current.work?.p50, previous.work?.p50),
		work_p90: sub(current.work?.p90, previous.work?.p90),
		runs_per_visit: sub(current.runs.per_visit, previous.runs.per_visit),
		sent_back_share: sub(current.sent_back.share, previous.sent_back.share),
		outcomes
	};
}

/** True when the state saw anything at all in the window — the row filter. */
function sawWork(f: StageWindowFigures): boolean {
	return f.visits > 0 || f.exits > 0 || f.runs.total > 0 || f.runs.unbound > 0;
}

export function computeStageStats(input: StatsInput): StageStatsReport {
	const states = new Map(input.states.map((s) => [s.id, s]));
	const until = input.now;
	const since = until - input.windowMs;
	const prevSince = since - input.windowMs;

	const visits = buildVisits(input.events, states);
	const { bound, unbound } = bindRuns(visits, input.runs);
	const ctx: FiguresContext = {
		visits,
		bound,
		unbound,
		states,
		advancedByKey: input.advancedByKey,
		now: input.now
	};

	const rows: StageStats[] = [];
	for (const state of input.states) {
		// Human stages get the Now row's one-line summary, never a table row.
		if (state.category !== 'active') continue;
		const current = stageFigures(state.id, ctx, since, until);
		const previous = input.compare ? stageFigures(state.id, ctx, prevSince, since) : null;
		if (!sawWork(current) && !(previous && sawWork(previous))) continue;
		rows.push({
			state_id: state.id,
			state_name: state.name,
			workflow_id: state.workflow_id,
			workflow_name: state.workflow_name,
			current,
			previous,
			delta: deltaOf(current, previous)
		});
	}

	// Worst queue first — the board's question is "where is work sitting?".
	rows.sort(
		(a, b) =>
			(b.current.queue_wait?.total ?? -1) - (a.current.queue_wait?.total ?? -1) ||
			a.workflow_name.localeCompare(b.workflow_name) ||
			a.state_name.localeCompare(b.state_name)
	);

	return {
		generated_at: input.now,
		window: { ms: input.windowMs, since, until },
		previous: input.compare ? { since: prevSince, until: since } : null,
		project: input.project,
		outcome_recorded_since: input.outcomeRecordedSince,
		states: rows
	};
}
