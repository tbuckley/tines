import { actorLabel } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { actorOf, serializeEvent } from './events';

const baseRow = {
	id: 'evt_1',
	type: 'issue.created',
	issue_id: 'iss_1',
	project_id: 'prj_1',
	payload: '{"title":"Fix it"}',
	created_at: 1723000000000,
	actor_user_id: 'usr_1',
	actor_user_name: 'alice',
	actor_api_key_id: null,
	actor_api_key_name: null,
	actor_run_id: null,
	actor_runner_name: null,
	actor_run_workflow_name: null,
	actor_run_state_name: null,
	actor_run_project_name: null,
	actor_run_issue_number: null,
	issue_number: 7,
	issue_title: 'Fix it',
	project_name: 'api',
	issue_project_name: 'api',
	issue_project_id: 'prj_1',
	other_project_id: null
};

describe('serializeEvent', () => {
	it('parses the payload and denormalizes the issue ref', () => {
		const ev = serializeEvent(baseRow);
		expect(ev.payload).toEqual({ title: 'Fix it' });
		expect(ev.issue_ref).toEqual({
			project_id: 'prj_1',
			project_name: 'api',
			number: 7,
			title: 'Fix it'
		});
		expect(ev.actor).toEqual({
			user_id: 'usr_1',
			user_name: 'alice',
			api_key_id: null,
			api_key_name: null
		});
	});

	it('falls back to an empty payload on invalid JSON', () => {
		const ev = serializeEvent({ ...baseRow, payload: 'not json' });
		expect(ev.payload).toEqual({});
	});

	it('drops the issue ref when the issue is gone', () => {
		const ev = serializeEvent({
			...baseRow,
			issue_id: null,
			issue_number: null,
			issue_title: null
		});
		expect(ev.issue_ref).toBeNull();
	});

	it('keeps historical project attribution while linking the current canonical ref', () => {
		const ev = serializeEvent({
			...baseRow,
			project_name: 'source',
			issue_project_name: 'destination',
			issue_number: 12
		});
		expect(ev.project_name).toBe('source');
		expect(ev.issue_ref).toEqual({
			project_id: 'prj_1',
			project_name: 'destination',
			number: 12,
			title: 'Fix it'
		});
	});
});

describe('actorOf', () => {
	it('labels API-key actors with the key name', () => {
		const actor = actorOf({
			actor_user_id: 'usr_1',
			actor_user_name: 'alice',
			actor_api_key_id: 'key_1',
			actor_api_key_name: 'laptop-claude'
		});
		expect(actor.api_key_name).toBe('laptop-claude');
	});

	it('nulls the key name for session actors even if a stale name is joined', () => {
		const actor = actorOf({
			actor_user_id: 'usr_1',
			actor_user_name: 'alice',
			actor_api_key_id: null,
			actor_api_key_name: 'stale'
		});
		expect(actor.api_key_name).toBeNull();
	});

	it('retains and renders descriptive run-key names with structural provenance', () => {
		const actor = actorOf({
			actor_user_id: 'usr_1',
			actor_user_name: 'alice',
			actor_api_key_id: 'key_1',
			actor_api_key_name: 'old-laptop · Engineering/Design',
			actor_run_id: 'arun_1',
			actor_runner_name: 'laptop-m4',
			actor_run_workflow_name: 'Engineering',
			actor_run_state_name: 'Design',
			actor_run_project_name: 'demo',
			actor_run_issue_number: 12
		});
		expect(actor.run).toEqual({
			run_id: 'arun_1',
			runner_name: 'laptop-m4',
			stage: { workflow_name: 'Engineering', state_name: 'Design' },
			issue_ref: { project_name: 'demo', number: 12 }
		});
		expect(actor.api_key_name).toBe('old-laptop · Engineering/Design');
		expect(actorLabel(actor)).toBe('alice via old-laptop · Engineering/Design · run on demo/12');
	});

	it('falls back to the run id when the run’s issue is gone', () => {
		const actor = actorOf({
			actor_user_id: 'usr_1',
			actor_user_name: 'alice',
			actor_api_key_id: 'key_1',
			actor_api_key_name: 'run arun_1',
			actor_run_id: 'arun_1',
			actor_runner_name: 'laptop-m4',
			actor_run_project_name: null,
			actor_run_issue_number: null
		});
		expect(actor.run?.issue_ref).toBeNull();
		expect(actorLabel(actor)).toBe('alice via laptop-m4 · run arun_1');
	});

	it('leaves ordinary key actors without run provenance', () => {
		const actor = actorOf({
			actor_user_id: 'usr_1',
			actor_user_name: 'alice',
			actor_api_key_id: 'key_1',
			actor_api_key_name: 'laptop-claude',
			actor_run_id: null,
			actor_runner_name: null
		});
		expect(actor.run).toBeUndefined();
		expect(actorLabel(actor)).toBe('alice via laptop-claude');
	});
});
