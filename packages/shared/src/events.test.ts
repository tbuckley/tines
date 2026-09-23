import { describe, expect, it } from 'vitest';
import { describeEvent, displayActor, eventSummary } from './events.js';
import { EVENT_TYPES } from './types.js';
import type { Actor, KnownEventType, TinesEvent } from './types.js';

const ACTOR: Actor = {
	user_id: 'usr_1',
	user_name: 'Alice',
	api_key_id: null,
	api_key_name: null,
	run: null
};

function event(
	type: string,
	payload: Record<string, unknown> = {},
	over: Partial<TinesEvent> = {}
): TinesEvent {
	return {
		id: 'evt_1',
		type,
		actor: ACTOR,
		issue_id: 'iss_1',
		project_id: 'prj_1',
		issue_ref: { project_name: 'Tines', number: 49, title: 'A title' },
		project_name: 'Tines',
		payload,
		created_at: 0,
		...over
	};
}

/**
 * One representative payload per known type, so the table below exercises every
 * describer with the fields the server actually emits rather than an empty
 * object. Shapes are taken from the emitting call sites in
 * `apps/web/src/lib/server/api/`.
 */
const PAYLOADS: Record<KnownEventType, Record<string, unknown>> = {
	'issue.created': { title: 'A title' },
	'issue.updated': { changed: ['title', 'description'] },
	'issue.transferred': {
		source_project_id: 'prj_a',
		source_project_name: 'Alpha',
		destination_project_id: 'prj_b',
		destination_project_name: 'Beta',
		old_number: 4,
		new_number: 9,
		old_ref: 'Alpha/4',
		new_ref: 'Beta/9'
	},
	'issue.transitioned': {
		action: 'Start work',
		from_state_name: 'Backlog',
		to_state_name: 'Design'
	},
	'issue.commented': { comment_id: 'cmt_1' },
	'issue.comment_edited': { comment_id: 'cmt_1', changed: ['body'] },
	'issue.comment_deleted': { comment_id: 'cmt_1', body_length: 42 },
	'issue.link_added': {
		link_id: 'lnk_1',
		kind: 'blocks',
		role: 'source',
		other_issue_id: 'iss_2',
		other_project_name: 'Tines',
		other_number: 40,
		other_title: 'The other one'
	},
	'issue.link_removed': {
		link_id: 'lnk_1',
		kind: 'blocks',
		role: 'source',
		other_issue_id: 'iss_2',
		other_project_name: 'Tines',
		other_number: 40,
		other_title: 'The other one'
	},
	'issue.labeled': { label_id: 'lbl_1', name: 'bug' },
	'issue.unlabeled': { label_id: 'lbl_1', name: 'bug' },
	'label.created': { label_id: 'lbl_1', name: 'bug' },
	'label.updated': { label_id: 'lbl_1', name: 'bug' },
	'label.deleted': { label_id: 'lbl_1', name: 'bug' },
	'project.created': { name: 'Tines' },
	'project.updated': { name: 'Tines' },
	'project.deleted': { name: 'Tines' },
	'project.archived': {
		name: 'Tines',
		schedules_paused: 2,
		draining_runs: 1,
		issues_read_only: 91
	},
	'project.unarchived': { name: 'Tines', schedules_resumed: 2 },
	'workflow.created': { name: 'Engineering' },
	'workflow.updated': { name: 'Engineering' },
	'workflow.deleted': { name: 'Engineering' },
	'api_key.created': { name: 'laptop' },
	'api_key.permissions_updated': { name: 'laptop' },
	'api_key.revoked': { name: 'laptop' },
	'scheduled_task.created': { name: 'Daily triage' },
	'scheduled_task.updated': { name: 'Daily triage' },
	'scheduled_task.deleted': { name: 'Daily triage' },
	'scheduled_task.skipped': { name: 'Daily triage', blocking: ['iss_2', 'iss_3'] },
	'context.created': {
		context_id: 'ctx_1',
		kind: 'prompt',
		name: 'house-style',
		version: 2,
		scope: { label: 'project Tines' }
	},
	'context.updated': {
		context_id: 'ctx_1',
		kind: 'prompt',
		name: 'house-style',
		scope: { label: 'project Tines' }
	},
	'context.deleted': {
		context_id: 'ctx_1',
		kind: 'prompt',
		name: 'house-style',
		scope: { label: 'project Tines' }
	},
	'runner.registered': { name: 'macbook-claude' },
	'runner.updated': { name: 'macbook-claude' },
	'runner.daemon_replaced': { runner_id: 'rnr_1', name: 'macbook-claude' },
	'runner.removed': { name: 'macbook-claude' },
	'runner.errored': {
		runner_name: 'macbook-claude',
		consecutive_failures: 3,
		error: 'spawn failed'
	},
	'runner.rate_limited': {
		runner_name: 'macbook-claude',
		run_id: 'run_1',
		error: 'rate limited: session limit · resets 3pm (America/New_York)',
		resets_at: 1_788_739_260_000,
		reported_reset_at: 1_788_739_200_000,
		limit: 'five_hour'
	},
	'routing_rule.created': { scope_label: 'project Tines' },
	'routing_rule.updated': { scope_label: 'project Tines' },
	'routing_rule.deleted': { scope_label: 'project Tines' },
	'settings.updated': { changed: ['max_concurrent_runs'] },
	'agent_run.started': { runner_name: 'macbook-claude', tier: 'fast', model: 'opus' },
	'agent_run.ended': {
		runner_name: 'macbook-claude',
		status: 'timed_out',
		outcome: 'no transition'
	},
	'issue.parked': { attempt_count: 3 },
	'issue.resumed': {}
};

describe('describeEvent / eventSummary', () => {
	// The regression this whole module exists for: two hand-maintained switches
	// drifted, and `issue.link_added` fell through to the bare type string in the
	// CLI. Nothing may fall through again.
	it.each(EVENT_TYPES)('renders %s without falling through to the type string', (type) => {
		const ev = event(type, PAYLOADS[type]);
		const segments = describeEvent(ev);
		expect(segments.length).toBeGreaterThan(0);
		const summary = eventSummary(ev);
		expect(summary).not.toBe('');
		expect(summary).not.toBe(type);
		expect(summary).not.toContain(type);
		// A missing payload field must degrade to absent prose, never "undefined".
		expect(summary).not.toContain('undefined');
		expect(summary).not.toContain('null');
	});

	it('covers every known type with a payload fixture', () => {
		expect(Object.keys(PAYLOADS).sort()).toEqual([...EVENT_TYPES].sort());
	});

	it('survives an empty payload for every known type', () => {
		for (const type of EVENT_TYPES) {
			expect(() => eventSummary(event(type, {}))).not.toThrow();
			expect(eventSummary(event(type, {}))).not.toBe('');
		}
	});

	it('renders "this issue" rather than a null ref when the issue is gone', () => {
		const ev = event('issue.commented', {}, { issue_ref: null });
		expect(eventSummary(ev)).toBe('commented on this issue');
	});
});

describe('issue link events', () => {
	const link = (
		type: 'issue.link_added' | 'issue.link_removed',
		kind: 'blocks' | 'duplicate_of',
		role: 'source' | 'target',
		other_title: string | null = 'The other one'
	) =>
		event(type, {
			link_id: 'lnk_1',
			kind,
			role,
			other_issue_id: 'iss_2',
			other_project_name: 'Tines',
			other_number: 40,
			other_title
		});

	// All four phrasings the web has always had, now the CLI's too. The payload
	// shape is the live one: the server emits the event once per endpoint, so
	// `role` alone decides direction.
	it.each([
		['blocks', 'source', 'marked Tines/#49 as blocking Tines/#40 — The other one'],
		['blocks', 'target', 'marked Tines/#49 as blocked by Tines/#40 — The other one'],
		['duplicate_of', 'source', 'marked Tines/#49 as a duplicate of Tines/#40 — The other one'],
		['duplicate_of', 'target', 'marked Tines/#40 as a duplicate of Tines/#49']
	] as const)('added / %s / %s', (kind, role, expected) => {
		expect(eventSummary(link('issue.link_added', kind, role))).toBe(expected);
	});

	it.each([
		['blocks', 'source', 'unmarked Tines/#49 as blocking Tines/#40 — The other one'],
		['blocks', 'target', 'unmarked Tines/#49 as blocked by Tines/#40 — The other one'],
		['duplicate_of', 'source', 'unmarked Tines/#49 as a duplicate of Tines/#40 — The other one'],
		['duplicate_of', 'target', 'unmarked Tines/#40 as a duplicate of Tines/#49']
	] as const)('removed / %s / %s', (kind, role, expected) => {
		expect(eventSummary(link('issue.link_removed', kind, role))).toBe(expected);
	});

	it('omits the trailing title gloss when the other ref comes first', () => {
		const segs = describeEvent(link('issue.link_added', 'duplicate_of', 'target'));
		expect(segs.map((s) => s.kind)).toEqual(['text', 'other-ref', 'text', 'self-ref']);
	});

	it('links the other issue as a ref segment, not as text', () => {
		const segs = describeEvent(link('issue.link_added', 'blocks', 'source'));
		expect(segs).toContainEqual({ kind: 'other-ref', project_name: 'Tines', number: 40 });
	});
});

describe('wording carried over from both surfaces', () => {
	it('keeps "moved" so the transition e2e assertion holds', () => {
		expect(eventSummary(event('issue.transitioned', PAYLOADS['issue.transitioned']))).toBe(
			'moved Tines/#49 via "Start work" Backlog → Design'
		);
	});

	it('says "directly" for a forced transition', () => {
		const ev = event('issue.transitioned', {
			forced: true,
			from_state_name: 'A',
			to_state_name: 'B'
		});
		expect(eventSummary(ev)).toBe('moved Tines/#49 directly A → B');
	});

	it('keeps the CLI-only context scope label when there is no issue ref', () => {
		const ev = event('context.created', PAYLOADS['context.created'], {
			issue_ref: null,
			issue_id: null
		});
		expect(eventSummary(ev)).toBe('created prompt "house-style" [project Tines]');
	});

	it('drops the scope label when the issue ref already names the scope', () => {
		expect(eventSummary(event('context.created', PAYLOADS['context.created']))).toBe(
			'created prompt "house-style" on Tines/#49'
		);
	});

	it('keeps the CLI-only skipped-occurrence count', () => {
		expect(eventSummary(event('scheduled_task.skipped', PAYLOADS['scheduled_task.skipped']))).toBe(
			'skipped an occurrence of schedule "Daily triage" (2 open instances)'
		);
	});

	it('singularises the skipped-occurrence count', () => {
		const ev = event('scheduled_task.skipped', { name: 'Daily triage', blocking: ['iss_2'] });
		expect(eventSummary(ev)).toBe(
			'skipped an occurrence of schedule "Daily triage" (1 open instance)'
		);
	});

	it('de-underscores a run status, the web behaviour', () => {
		expect(eventSummary(event('agent_run.ended', PAYLOADS['agent_run.ended']))).toBe(
			'run timed out — no transition via "macbook-claude" on Tines/#49'
		);
	});

	it('keeps the CLI-only model on a started run', () => {
		expect(eventSummary(event('agent_run.started', PAYLOADS['agent_run.started']))).toBe(
			'started a fast run (opus) via "macbook-claude" on Tines/#49'
		);
	});

	it('omits the model clause when the run has none', () => {
		const ev = event('agent_run.started', { runner_name: 'macbook-claude', tier: 'fast' });
		expect(eventSummary(ev)).toBe('started a fast run via "macbook-claude" on Tines/#49');
	});

	it('renders a workflow event by name, whatever else the payload carries', () => {
		// `inheritance_changed` (Tines/238) rides along on workflow.created /
		// .updated / .deleted; the feed names the workflow and nothing else, so
		// the key needs no renderer of its own.
		const ev = event('workflow.updated', {
			name: 'Engineering',
			inheritance_changed: [
				{ workflow: 'Engineering', state: 'Merging', from: null, to: 'Shared stages / Merging' }
			]
		});
		expect(eventSummary(ev)).toBe(eventSummary(event('workflow.updated', { name: 'Engineering' })));
	});

	it('keeps the web workflow-change clause on issue.updated', () => {
		const ev = event('issue.updated', {
			changed: ['workflow'],
			workflow_from_name: 'Old',
			workflow_to_name: 'New'
		});
		expect(eventSummary(ev)).toBe('updated workflow of Tines/#49 from "Old" to "New"');
	});

	it('falls back to the event project name when project.* has no payload name', () => {
		const ev = event('project.deleted', {}, { issue_ref: null, issue_id: null });
		expect(eventSummary(ev)).toBe('deleted project "Tines"');
	});
});

describe('forward compatibility', () => {
	// An installed CLI routinely reads a newer server's feed; unknown types must
	// degrade rather than throw or render blank.
	it('renders an unknown type as its own name plus the issue ref', () => {
		expect(eventSummary(event('future.thing', { anything: 1 }))).toBe('future.thing Tines/#49');
	});

	it('renders an unknown, issue-less type as just its name', () => {
		const ev = event('future.thing', {}, { issue_ref: null, issue_id: null });
		expect(eventSummary(ev)).toBe('future.thing');
	});

	it('does not throw on a missing payload', () => {
		const ev = event('issue.created', undefined as unknown as Record<string, unknown>);
		expect(() => eventSummary(ev)).not.toThrow();
	});
});

describe('displayActor', () => {
	it('attributes a sweep-created issue to its schedule', () => {
		const ev = event('issue.created', { title: 'A title', scheduled_task_name: 'Daily triage' });
		expect(displayActor(ev)).toBe('Alice via schedule “Daily triage”');
		// The attribution lives in the actor column now, not in the summary.
		expect(eventSummary(ev)).toBe('created Tines/#49 — A title');
	});

	it('keeps the plain actor for a run-now instance', () => {
		const ev = event('issue.created', {
			title: 'A title',
			scheduled_task_name: 'Daily triage',
			manual: true
		});
		expect(displayActor(ev)).toBe('Alice');
	});

	it('falls back to actorLabel for every other event', () => {
		const ev = event(
			'issue.commented',
			{},
			{
				actor: {
					...ACTOR,
					api_key_id: 'key_1',
					api_key_name: 'old-laptop · Engineering/Design',
					run: {
						run_id: 'arun_1',
						runner_name: 'new-laptop',
						issue_ref: { project_name: 'Tines', number: 49 }
					}
				}
			}
		);
		expect(displayActor(ev)).toBe('Alice via old-laptop · Engineering/Design · run on Tines/49');
	});
});
