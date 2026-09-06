import { beforeEach, describe, expect, it } from 'vitest';
import { NOW, PROJECT, USER, seedBase } from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import {
	clearStaleFocus,
	getPreferences,
	resolveFocus,
	setFocus,
	updatePreferences
} from './preferences';
import { createTestDb, type TestDb } from './test-db';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true,
	agentRunId: null
};

const OTHER_USER = 'u2';
const SECOND = 'prj_2';
const ARCHIVED = 'prj_archived';
const FOREIGN = 'prj_foreign';

let t: TestDb;

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('${OTHER_USER}', 'bob', 'b@example.com', 1, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('${SECOND}', '${USER}', 'second', ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at, archived_at)
			VALUES ('${ARCHIVED}', '${USER}', 'frozen', ${NOW}, ${NOW}, ${NOW});
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('${FOREIGN}', '${OTHER_USER}', 'theirs', ${NOW}, ${NOW});
	`);
});

describe('getPreferences', () => {
	it('reports the all-null defaults before the row exists', async () => {
		expect(await getPreferences(t.db, USER)).toEqual({
			focused_project_id: null,
			last_project_id: null,
			updated_at: null
		});
	});
});

describe('updatePreferences', () => {
	it('creates the row on first write and reads it back', async () => {
		const written = await updatePreferences(t.db, t.env, actor, { focused_project_id: PROJECT });
		expect(written.focused_project_id).toBe(PROJECT);
		expect(written.updated_at).toBeTypeOf('number');
		expect(await getPreferences(t.db, USER)).toEqual(written);
	});

	it('makes a newly focused project the New-issue fallback', async () => {
		const written = await updatePreferences(t.db, t.env, actor, { focused_project_id: PROJECT });
		expect(written.last_project_id).toBe(PROJECT);
	});

	it('keeps the fallback when the focus is cleared, so "last focused" survives', async () => {
		await updatePreferences(t.db, t.env, actor, { focused_project_id: PROJECT });
		const cleared = await updatePreferences(t.db, t.env, actor, { focused_project_id: null });
		expect(cleared.focused_project_id).toBeNull();
		expect(cleared.last_project_id).toBe(PROJECT);
	});

	it('lets an explicit last_project_id win over the focus it is written with', async () => {
		const written = await updatePreferences(t.db, t.env, actor, {
			focused_project_id: PROJECT,
			last_project_id: SECOND
		});
		expect(written).toMatchObject({ focused_project_id: PROJECT, last_project_id: SECOND });
	});

	it('leaves absent fields untouched', async () => {
		await updatePreferences(t.db, t.env, actor, { focused_project_id: PROJECT });
		const written = await updatePreferences(t.db, t.env, actor, { last_project_id: SECOND });
		expect(written).toMatchObject({ focused_project_id: PROJECT, last_project_id: SECOND });
	});

	it.each([
		['an unknown id', 'prj_nope'],
		['an archived project', ARCHIVED],
		["another user's project", FOREIGN]
	])('refuses %s as a focus', async (_label, id) => {
		await expect(
			updatePreferences(t.db, t.env, actor, { focused_project_id: id })
		).rejects.toMatchObject({ status: 422, code: 'invalid_field' });
	});

	it('refuses an archived project as the New-issue fallback too', async () => {
		await expect(
			updatePreferences(t.db, t.env, actor, { last_project_id: ARCHIVED })
		).rejects.toBeInstanceOf(ApiFail);
	});
});

describe('resolveFocus', () => {
	it('is All projects with no row at all', async () => {
		expect(await resolveFocus(t.db, USER)).toEqual({
			focusId: null,
			lastProjectId: null,
			staleFocusId: null
		});
	});

	it('resolves a live focus', async () => {
		await setFocus(t.db, t.env, actor, PROJECT);
		expect(await resolveFocus(t.db, USER)).toEqual({
			focusId: PROJECT,
			lastProjectId: PROJECT,
			staleFocusId: null
		});
	});

	it('reads an archived focus as All projects and reports it stale', async () => {
		await setFocus(t.db, t.env, actor, PROJECT);
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		expect(await resolveFocus(t.db, USER)).toEqual({
			focusId: null,
			lastProjectId: PROJECT,
			staleFocusId: PROJECT
		});
	});

	it('follows the project pointer to null when the project is deleted', async () => {
		await setFocus(t.db, t.env, actor, PROJECT);
		t.sqlite.exec(`DELETE FROM project WHERE id = '${PROJECT}'`);
		// ON DELETE SET NULL: nothing is left to be stale.
		expect(await resolveFocus(t.db, USER)).toEqual({
			focusId: null,
			lastProjectId: null,
			staleFocusId: null
		});
	});
});

describe('clearStaleFocus', () => {
	it('clears the stale pointer so unarchiving never restores the focus', async () => {
		await setFocus(t.db, t.env, actor, PROJECT);
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		await clearStaleFocus(t.db, t.env, USER, PROJECT);
		t.sqlite.exec(`UPDATE project SET archived_at = NULL WHERE id = '${PROJECT}'`);
		expect(await resolveFocus(t.db, USER)).toMatchObject({ focusId: null, staleFocusId: null });
	});

	it('does not undo a focus written after the stale one was read', async () => {
		await setFocus(t.db, t.env, actor, PROJECT);
		t.sqlite.exec(`UPDATE project SET archived_at = ${NOW} WHERE id = '${PROJECT}'`);
		// The race: a PATCH lands between the load's read and its deferred clear.
		await setFocus(t.db, t.env, actor, SECOND);
		await clearStaleFocus(t.db, t.env, USER, PROJECT);
		expect(await resolveFocus(t.db, USER)).toMatchObject({ focusId: SECOND });
	});
});
