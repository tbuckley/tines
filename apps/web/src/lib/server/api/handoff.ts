/**
 * The handoff derivations: what came back from the current round, and what the
 * human said since the last run ended.
 *
 * Both are pure functions over rows the caller already loaded, so they are unit
 * tested directly and `getIssueDetail` pays only for the reads. Nothing here is
 * stored: the round is re-derived from run attribution (`agent_run.issue_id`,
 * `api_key.agent_run_id`) that the supervisor already writes.
 */
import {
	isActiveRun,
	prUrlOf,
	type AgentRun,
	type Comment,
	type Round,
	type RoundArtifactChange,
	type RoundRun,
	type RoundStage,
	type RoundTransition,
	type SinceLastRun,
	type TinesEvent,
	type Workflow
} from '@tines/shared';
import type { IssueArtifactVersion } from './artifacts';

/** At most this many human comments ride along in `since_last_run`. */
export const SINCE_LAST_RUN_COMMENT_CAP = 10;

/** The `issue.transitioned` payload, as `transitionIssue` writes it. */
interface TransitionPayload {
	action?: unknown;
	forced?: unknown;
	from_state_id?: unknown;
	from_state_name?: unknown;
	to_state_id?: unknown;
	to_state_name?: unknown;
}

function str(v: unknown): string {
	return typeof v === 'string' ? v : '';
}

/**
 * A transitioned event as the derivations render it. A forced move
 * (`issues edit -s`) carries no action — the callers spell that "moved
 * directly" rather than inventing a name.
 */
function asTransition(event: TinesEvent): RoundTransition {
	const p = event.payload as TransitionPayload;
	return {
		action: typeof p.action === 'string' ? p.action : null,
		from_state: { id: str(p.from_state_id), name: str(p.from_state_name) },
		to_state: { id: str(p.to_state_id), name: str(p.to_state_name) },
		actor: event.actor,
		at: event.created_at
	};
}

function runIdOf(actor: { run?: { run_id: string } | null }): string | null {
	return actor.run?.run_id ?? null;
}

export interface RoundInput {
	issue: { id: string; created_at: number };
	workflow: Workflow;
	/** `issue.transitioned` events on this issue, oldest first. */
	events: TinesEvent[];
	/** Runs on this issue, any order. */
	runs: AgentRun[];
	/** The issue's comments, oldest first. */
	comments: Comment[];
	/** Every artifact version on the issue, oldest first. */
	versions: IssueArtifactVersion[];
}

/**
 * The runs since the human last acted, grouped by the state each started in.
 *
 * Null when no run falls inside the round — a human moved the issue here
 * directly, so there is nothing to hand back.
 */
export function deriveRound(input: RoundInput): Round | null {
	const { issue, workflow, events, runs, comments, versions } = input;
	// The boundary is the last human-taken transition. A forced move counts (a
	// human made it); a workflow change does not, since it emits no transition.
	const boundaryEvent = [...events].reverse().find((e) => runIdOf(e.actor) === null) ?? null;
	const boundaryAt = boundaryEvent?.created_at ?? issue.created_at;

	const roundRuns = runs
		.filter((r) => r.created_at > boundaryAt)
		.sort((a, b) => a.created_at - b.created_at);
	if (roundRuns.length === 0) return null;

	const inRound = new Set(roundRuns.map((r) => r.id));
	const entries = roundRuns.map((run) => roundRunOf(run, events, comments, versions));

	// Group by the state each run started in, latest run first inside a group.
	const byState = new Map<string, RoundRun[]>();
	for (let i = 0; i < roundRuns.length; i += 1) {
		const list = byState.get(roundRuns[i].state_id_at_start) ?? [];
		list.push(entries[i]);
		byState.set(roundRuns[i].state_id_at_start, list);
	}
	const stages: RoundStage[] = [];
	for (const [stateId, group] of byState) {
		group.reverse();
		const runsAtStage = roundRuns.filter((r) => r.state_id_at_start === stateId);
		// Every entry but the stage's latest is an earlier attempt: name the
		// transition that brought the issue back here afterwards.
		for (let i = 1; i < group.length; i += 1) {
			const source = runsAtStage[runsAtStage.length - 1 - i];
			const after = source.ended_at ?? source.created_at;
			const back = events.find(
				(e) => e.created_at > after && str((e.payload as TransitionPayload).to_state_id) === stateId
			);
			group[i].returned_via = back ? asTransition(back) : null;
		}
		const wfState = workflow.states.find((s) => s.id === stateId);
		stages.push({
			state: {
				id: stateId,
				name: wfState?.name ?? runsAtStage[0].state_at_start_name,
				position: wfState?.position ?? null
			},
			runs: group
		});
	}
	// Workflow order; a state the workflow no longer has sorts last, keeping
	// the order it was first seen in.
	stages.sort((a, b) => (a.state.position ?? Infinity) - (b.state.position ?? Infinity));

	return {
		boundary: boundaryEvent ? asTransition(boundaryEvent) : null,
		boundary_at: boundaryAt,
		stages,
		run_count: inRound.size
	};
}

function roundRunOf(
	run: AgentRun,
	events: TinesEvent[],
	comments: Comment[],
	versions: IssueArtifactVersion[]
): RoundRun {
	// A run takes at most one transition; if the log ever holds two, the last
	// one is the one that moved the issue on.
	const transitions = events.filter((e) => runIdOf(e.actor) === run.id);
	const own = comments.filter((c) => runIdOf(c.actor) === run.id);
	const summary = own.length > 0 ? own[own.length - 1] : null;
	return {
		run_id: run.id,
		runner_name: run.runner_name,
		status: run.status,
		outcome: run.outcome,
		started_at: run.started_at,
		ended_at: run.ended_at,
		usage: run.usage,
		transition: transitions.length > 0 ? asTransition(transitions[transitions.length - 1]) : null,
		summary_comment: summary
			? { id: summary.id, body: summary.body, created_at: summary.created_at }
			: null,
		earlier_comment_ids: own.slice(0, -1).map((c) => c.id),
		artifacts: artifactChangesOf(run, versions),
		returned_via: null
	};
}

/** The artifacts one run touched, with the version numbers either side. */
function artifactChangesOf(run: AgentRun, versions: IssueArtifactVersion[]): RoundArtifactChange[] {
	// Attribution is by run id, never by the run's issue ref: a version left on
	// this issue by a run working *another* issue carries that run's id, which
	// is never one of this round's, so it can never be folded in here. (The
	// row-level summary in `issues.ts` has no run to key on and must compare
	// `actor_run_issue_id` instead.)
	const mine = versions.filter((v) => v.actor_run_id === run.id);
	const byItem = new Map<string, IssueArtifactVersion[]>();
	for (const v of mine) {
		const list = byItem.get(v.item_id) ?? [];
		list.push(v);
		byItem.set(v.item_id, list);
	}
	const changes: RoundArtifactChange[] = [];
	for (const [itemId, list] of byItem) {
		const first = list[0];
		const last = list[list.length - 1];
		const before = versions
			.filter((v) => v.item_id === itemId && v.version < first.version)
			.map((v) => v.version);
		changes.push({
			name: last.name,
			artifact_type: last.artifact_type,
			from_version: before.length > 0 ? Math.max(...before) : null,
			to_version: last.version,
			pr_url: prUrlOf(last),
			files: last.artifact_type === 'folder' ? last.files : null
		});
	}
	return changes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export interface SinceLastRunInput {
	issue: { created_at: number; state_entered_at: number };
	events: TinesEvent[];
	runs: AgentRun[];
	comments: Comment[];
	versions: IssueArtifactVersion[];
}

/**
 * The human's steer since the previous run ended: the transition they took,
 * the comments they left, and what their move made stale.
 *
 * Null when no run has finished yet, or when the previous run's transition led
 * straight to another agent run without a human touching the issue.
 */
export function deriveSinceLastRun(input: SinceLastRunInput): SinceLastRun | null {
	const { issue, events, runs, comments, versions } = input;
	// At dispatch time the current run's row already exists, so "previous run"
	// is the newest run that is no longer active.
	const previous = runs
		.filter((r) => !isActiveRun(r.status))
		.sort((a, b) => b.created_at - a.created_at)[0];
	if (!previous) return null;
	const since = previous.ended_at ?? previous.created_at;

	const humanTransitions = events.filter((e) => e.created_at > since && runIdOf(e.actor) === null);
	const transition = humanTransitions[humanTransitions.length - 1] ?? null;
	const humanComments = comments.filter((c) => c.created_at > since && runIdOf(c.actor) === null);
	if (!transition && humanComments.length === 0) return null;

	return {
		previous_run: {
			run_id: previous.id,
			ended_at: previous.ended_at,
			state_at_start_name: previous.state_at_start_name
		},
		transition: transition ? asTransition(transition) : null,
		comments: humanComments.slice(-SINCE_LAST_RUN_COMMENT_CAP),
		comment_count: humanComments.length,
		stale_artifacts: transition ? staleArtifacts(issue, events, transition, versions) : []
	};
}

/**
 * Artifacts the human's move made stale: their current version was produced by
 * the round the human just ended, and is stale now.
 *
 * Deliberately measured from the previous *human* transition, not from the one
 * before the human's move: a run attaches its artifact before it transitions,
 * so a version is never fresh in the state the run handed the issue to, and
 * the narrower window would always be empty.
 */
function staleArtifacts(
	issue: { created_at: number; state_entered_at: number },
	events: TinesEvent[],
	transition: TinesEvent,
	versions: IssueArtifactVersion[]
): string[] {
	const before = events.filter(
		(e) => e.created_at < transition.created_at && runIdOf(e.actor) === null
	);
	const roundStarted = before[before.length - 1]?.created_at ?? issue.created_at;
	const byItem = new Map<string, IssueArtifactVersion>();
	for (const v of versions) {
		const seen = byItem.get(v.item_id);
		if (!seen || v.version > seen.version) byItem.set(v.item_id, v);
	}
	return [...byItem.values()]
		.filter((v) => v.created_at < issue.state_entered_at && v.created_at >= roundStarted)
		.map((v) => v.name)
		.sort();
}
