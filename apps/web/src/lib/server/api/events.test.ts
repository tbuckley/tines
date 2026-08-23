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
	issue_number: 7,
	issue_title: 'Fix it',
	project_name: 'api'
};

describe('serializeEvent', () => {
	it('parses the payload and denormalizes the issue ref', () => {
		const ev = serializeEvent(baseRow);
		expect(ev.payload).toEqual({ title: 'Fix it' });
		expect(ev.issue_ref).toEqual({ project_name: 'api', number: 7, title: 'Fix it' });
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
		const ev = serializeEvent({ ...baseRow, issue_id: null, issue_number: null, issue_title: null });
		expect(ev.issue_ref).toBeNull();
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
});
