/**
 * The one description of what an activity event *says*, shared by the CLI's
 * `events list` and the web's `EventList.svelte`.
 *
 * Both surfaces used to carry their own hand-maintained switch over the event
 * union, and they diverged in production: the CLI never learned the two
 * `issue.link_*` types and printed the bare type string for them. The fix is
 * this module plus `DESCRIBERS` being a `Record<KnownEventType, …>`, so a new
 * member of `EVENT_TYPES` is a compile error until it is rendered.
 *
 * Rendering is structural rather than a string, because the web linkifies issue
 * references and draws state badges: `describeEvent` returns ordered segments,
 * the component renders each kind its own way, and `eventSummary` is the
 * plain-text join the CLI prints.
 */

import { actorLabel } from './types.js';
import type { KnownEventType, TinesEvent } from './types.js';

/**
 * One piece of an event's description. The surfaces differ only in how they
 * draw each kind — never in which kinds appear or in what order.
 */
export type EventSegment =
	/** Muted connective prose. */
	| { kind: 'text'; text: string }
	/**
	 * The issue the event belongs to: a link on the global feed, "this issue"
	 * on the issue's own page, `Proj/#N` in the CLI.
	 */
	| { kind: 'self-ref' }
	/** The other end of an issue link; always a link on the web. */
	| { kind: 'other-ref'; project_id?: string; project_name: string; number: number }
	/**
	 * An emphasised, quoted name — schedule/context/runner/key names and
	 * transition actions. The *renderer* adds the quotes (curly on the web,
	 * straight in the CLI), so each surface keeps its own typography.
	 */
	| { kind: 'name'; text: string }
	/** `issue.transitioned`'s state pair: badges on the web, `from → to` in text. */
	| { kind: 'state-transition'; from: string; to: string };

const text = (t: string): EventSegment => ({ kind: 'text', text: t });
const name = (t: unknown): EventSegment => ({ kind: 'name', text: str(t) });
const selfRef = (): EventSegment => ({ kind: 'self-ref' });

function str(v: unknown): string {
	return v === null || v === undefined ? '' : String(v);
}

/** An epoch-ms payload field as an ISO string; the surfaces reformat if they wish. */
function isoTime(v: unknown): string {
	return typeof v === 'number' && Number.isFinite(v)
		? new Date(v).toISOString()
		: 'an unknown time';
}

/** Comma/`and` joins over a payload's `changed` array, which may be absent. */
function joinChanged(v: unknown, sep: string): string {
	return Array.isArray(v) ? v.join(sep) : '';
}

/** The `.created` / `.updated` / `.deleted` half of a dotted event type. */
function action(type: string): string {
	return type.split('.')[1] ?? type;
}

function otherRef(p: Record<string, unknown>): EventSegment {
	return {
		kind: 'other-ref',
		...(typeof p.other_project_id === 'string' ? { project_id: p.other_project_id } : {}),
		project_name: str(p.other_project_name),
		number: Number(p.other_number)
	};
}

/**
 * Link events read as sentences from the owning issue's perspective: "marked
 * this issue as blocking demo/#14". The one shape that puts the other issue
 * first is "marked web/#9 as a duplicate of this issue" (role `target`).
 *
 * The server emits the event twice, once per endpoint, so `role` — not the
 * issue ids — decides direction. `kind` as emitted is only `blocks` or
 * `duplicate_of`; `blocked_by` is normalised away server-side.
 */
function linkSegments(ev: TinesEvent, p: Record<string, unknown>): EventSegment[] {
	const lead = ev.type === 'issue.link_added' ? 'marked' : 'unmarked';
	if (!Number.isFinite(Number(p.other_number)))
		return [text('changed an issue link on'), selfRef()];
	const duplicate = p.kind === 'duplicate_of';
	if (duplicate && p.role === 'target') {
		return [text(lead), otherRef(p), text('as a duplicate of'), selfRef()];
	}
	const middle = duplicate
		? 'as a duplicate of'
		: p.role === 'target'
			? 'as blocked by'
			: 'as blocking';
	const segs = [text(lead), selfRef(), text(middle), otherRef(p)];
	// The title only reads as a trailing gloss when the other ref comes last.
	if (p.other_title) segs.push(text(`— ${str(p.other_title)}`));
	return segs;
}

type Describer = (ev: TinesEvent, p: Record<string, unknown>) => EventSegment[];

/**
 * One entry per known event type. Adding a member to `EVENT_TYPES` without
 * adding it here is `TS2741` at build time — that compile error is the whole
 * point of this map being a `Record` over the closed set.
 */
const DESCRIBERS: Record<KnownEventType, Describer> = {
	'issue.created': (_ev, p) => {
		const segs = [text('created'), selfRef()];
		if (p.title) segs.push(text(`— ${str(p.title)}`));
		return segs;
	},
	'issue.updated': (_ev, p) => {
		const changed = joinChanged(p.changed, ' and ');
		const segs = [text(changed ? `updated ${changed} of` : 'updated'), selfRef()];
		if (p.workflow_to_name) {
			segs.push(text('from'), name(p.workflow_from_name), text('to'), name(p.workflow_to_name));
		}
		return segs;
	},
	'issue.transferred': (_ev, p) => [
		text('transferred'),
		selfRef(),
		text('from'),
		name(p.old_ref),
		text('to'),
		name(p.new_ref)
	],
	'issue.transitioned': (_ev, p) => {
		const segs = [text('moved'), selfRef()];
		if (p.action) segs.push(text('via'), name(p.action));
		else if (p.forced) segs.push(text('directly'));
		segs.push({
			kind: 'state-transition',
			from: str(p.from_state_name) || '?',
			to: str(p.to_state_name) || '?'
		});
		return segs;
	},
	'issue.commented': () => [text('commented on'), selfRef()],
	'issue.comment_edited': () => [text('edited a comment on'), selfRef()],
	'issue.comment_deleted': () => [text('deleted a comment on'), selfRef()],
	'issue.link_added': linkSegments,
	'issue.link_removed': linkSegments,
	'issue.labeled': (_ev, p) => [text('labeled'), selfRef(), name(p.name)],
	'issue.unlabeled': (_ev, p) => [text('removed label'), name(p.name), text('from'), selfRef()],
	'label.created': (ev, p) => [text(`${action(ev.type)} label`), name(p.name)],
	'label.updated': (ev, p) => [text(`${action(ev.type)} label`), name(p.name)],
	'label.deleted': (ev, p) => [text(`${action(ev.type)} label`), name(p.name)],
	'issue.parked': (_ev, p) => [
		text('parked'),
		selfRef(),
		text(`after ${str(p.attempt_count)} strikes — needs attention`)
	],
	'issue.resumed': () => [text('resumed'), selfRef(), text('(attempt count reset)')],
	'project.created': (ev, p) => projectSegments(ev, p),
	'project.updated': (ev, p) => projectSegments(ev, p),
	'project.deleted': (ev, p) => projectSegments(ev, p),
	'project.archived': (ev, p) => projectSegments(ev, p),
	'project.unarchived': (ev, p) => projectSegments(ev, p),
	'workflow.created': (ev, p) => [text(`${action(ev.type)} workflow`), name(p.name)],
	'workflow.updated': (ev, p) => [text(`${action(ev.type)} workflow`), name(p.name)],
	'workflow.deleted': (ev, p) => [text(`${action(ev.type)} workflow`), name(p.name)],
	'api_key.created': (_ev, p) => [text('created API key'), name(p.name)],
	'api_key.permissions_updated': (_ev, p) => [
		text('updated permissions for API key'),
		name(p.name)
	],
	'api_key.revoked': (_ev, p) => [text('revoked API key'), name(p.name)],
	'scheduled_task.created': (ev, p) => [text(`${action(ev.type)} schedule`), name(p.name)],
	'scheduled_task.personal_permission_changed': (_ev, p) => [
		text('changed future permission for schedule'),
		name(p.schedule_id)
	],
	'scheduled_task.updated': (ev, p) => [text(`${action(ev.type)} schedule`), name(p.name)],
	'scheduled_task.deleted': (ev, p) => [text(`${action(ev.type)} schedule`), name(p.name)],
	'scheduled_task.skipped': (_ev, p) => {
		const blocking = Array.isArray(p.blocking) ? p.blocking.length : 0;
		return [
			text('skipped an occurrence of schedule'),
			name(p.name),
			text(`(${blocking} open instance${blocking === 1 ? '' : 's'})`)
		];
	},
	'context.created': (ev, p) => contextSegments(ev, p),
	'context.updated': (ev, p) => contextSegments(ev, p),
	'context.deleted': (ev, p) => contextSegments(ev, p),
	'runner.registered': (ev, p) => [text(`${action(ev.type)} runner`), name(p.name)],
	'runner.updated': (ev, p) => [text(`${action(ev.type)} runner`), name(p.name)],
	'runner.daemon_replaced': (_ev, p) => [text('replaced daemon for runner'), name(p.name)],
	'runner.removed': (ev, p) => [text(`${action(ev.type)} runner`), name(p.name)],
	'runner.errored': (_ev, p) => [
		text('saw runner'),
		name(p.runner_name),
		// Not "fail to launch": the same counter now also carries runs a
		// runner dropped after launch. The cause is in the error text.
		text(`fail (${str(p.consecutive_failures)} consecutive): ${str(p.error)}`)
	],
	'runner.rate_limited': (_ev, p) => [
		text('saw runner'),
		name(p.runner_name),
		// A provider condition, not a failure: the runner holds itself until the
		// reported reset and resumes with nobody in the loop.
		text(`hit its usage limit — resumes ${isoTime(p.resets_at)}: ${str(p.error)}`)
	],
	'routing_rule.created': (ev, p) => [
		text(`${action(ev.type)} the ${str(p.scope_label)} routing rule`)
	],
	'routing_rule.updated': (ev, p) => [
		text(`${action(ev.type)} the ${str(p.scope_label)} routing rule`)
	],
	'routing_rule.deleted': (ev, p) => [
		text(`${action(ev.type)} the ${str(p.scope_label)} routing rule`)
	],
	'settings.updated': (_ev, p) => [
		text(`updated supervisor settings (${joinChanged(p.changed, ', ') || 'no changes'})`)
	],
	'agent_run.started': (_ev, p) => {
		const segs = [text(`started a ${str(p.tier)} run`)];
		if (p.model) segs.push(text(`(${str(p.model)})`));
		segs.push(text('via'), name(p.runner_name), text('on'), selfRef());
		return segs;
	},
	'agent_run.ended': (_ev, p) => {
		const segs = [text(`run ${str(p.status).replaceAll('_', ' ')}`)];
		if (p.outcome) segs.push(text(`— ${str(p.outcome)}`));
		segs.push(text('via'), name(p.runner_name), text('on'), selfRef());
		return segs;
	}
};

/** `project.*`: the name lives in the payload, but old events only have the ref. */
function projectSegments(ev: TinesEvent, p: Record<string, unknown>): EventSegment[] {
	return [text(`${action(ev.type)} project`), name(p.name ?? ev.project_name)];
}

/**
 * `context.*`: the scope label is only worth printing when there is no issue
 * reference — an issue-scoped item sets `issue_id` on the event itself, so the
 * label would just repeat the link that already follows.
 */
function contextSegments(ev: TinesEvent, p: Record<string, unknown>): EventSegment[] {
	const segs = [text(`${action(ev.type)} ${str(p.kind)}`), name(p.name)];
	if (ev.issue_ref) {
		segs.push(text('on'), selfRef());
	} else {
		const label = (p.scope as { label?: string } | undefined)?.label;
		if (label) segs.push(text(`[${label}]`));
	}
	return segs;
}

/**
 * The event's description, as ordered segments.
 *
 * Unknown types fall back to the raw type string. That branch is load-bearing
 * forward compatibility, not dead code: an installed CLI routinely reads a
 * newer server's feed and must degrade rather than throw.
 */
export function describeEvent(ev: TinesEvent): EventSegment[] {
	const describe = (DESCRIBERS as Record<string, Describer | undefined>)[ev.type];
	const segs = describe
		? describe(ev, ev.payload ?? {})
		: ev.issue_ref
			? [text(ev.type), selfRef()]
			: [text(ev.type)];
	// A payload can be missing any field; drop the empty prose it produces
	// rather than rendering a stray separator or a pair of empty quotes.
	return segs.filter((s) => (s.kind === 'text' || s.kind === 'name' ? s.text !== '' : true));
}

/** Plain-text rendering of one segment — the CLI's typography. */
function segmentText(ev: TinesEvent, seg: EventSegment): string {
	switch (seg.kind) {
		case 'text':
			return seg.text;
		case 'name':
			return `"${seg.text}"`;
		case 'self-ref':
			return ev.issue_ref ? `${ev.issue_ref.project_name}/#${ev.issue_ref.number}` : 'this issue';
		case 'other-ref':
			return `${seg.project_name}/#${seg.number}`;
		case 'state-transition':
			return `${seg.from} → ${seg.to}`;
	}
}

/** One-line prose for an event: the whole of the CLI's renderer. */
export function eventSummary(ev: TinesEvent): string {
	return describeEvent(ev)
		.map((seg) => segmentText(ev, seg))
		.filter((s) => s !== '')
		.join(' ');
}

/**
 * Actor with schedule attribution folded in.
 *
 * Sweep-created issues carry the schedule in the payload and no API key, so
 * they read “Alice via schedule “Daily triage””, parallel to API-key
 * attribution. Run-now instances (`manual: true`) keep the plain actor.
 */
export function displayActor(ev: TinesEvent): string {
	const p = ev.payload ?? {};
	if (ev.type === 'issue.created' && p.scheduled_task_name && !p.manual) {
		return `${ev.actor.user_name} via schedule “${str(p.scheduled_task_name)}”`;
	}
	return actorLabel(ev.actor);
}
