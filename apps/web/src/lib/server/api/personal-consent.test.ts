import { describe, expect, it } from 'vitest';
import {
	addIssue,
	addRun,
	addRunner,
	issueById,
	NOW,
	PROJECT,
	runById,
	seedBase,
	USER
} from '../supervisor/test-fixtures';
import { ApiFail, type ActorContext } from './core';
import { createTestDb } from './test-db';
import {
	acknowledgeDisclosure,
	assertConsentFieldsSupported,
	readIssueConsent,
	rejectKeyConsentInput,
	writeIssueConsent
} from './personal-consent';
import { writeIssueHold } from './issue-controls';
import { createIssue, updateIssue } from './issues';
import { TEST_NOOP_DISPATCH_EFFECTS } from './test-dispatch-effects';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function sharedIssue() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite
		.prepare('UPDATE project SET shared_at = ?, sharing_revision = 1 WHERE id = ?')
		.run(NOW, PROJECT);
	return { t, issueId: addIssue(t) };
}

describe('owner issue permission', () => {
	it('rejects every explicit key choice, including false, before a domain write', () => {
		const key = { ...session, apiKeyId: 'key_named', apiKeyName: 'automation', viaSession: false };
		for (const body of [
			{ allow_my_agents: true },
			{ allow_my_agents: false },
			{ schedule: { future_allow_my_agents: true } }
		]) {
			expect(() => rejectKeyConsentInput(key, body)).toThrowError(ApiFail);
			try {
				rejectKeyConsentInput(key, body);
			} catch (error) {
				expect((error as ApiFail).code).toBe('consent_browser_required');
			}
		}
		expect(() =>
			assertConsentFieldsSupported(
				key,
				{
					expected_consent_revision: 2,
					expected_consent_epoch: 1,
					expected_decision_revision: 3
				},
				['expected_consent_revision', 'expected_consent_epoch', 'expected_decision_revision']
			)
		).not.toThrow();
	});

	it('stores a revisioned session choice and refuses stale off-after-on intent', async () => {
		const { t, issueId } = sharedIssue();
		const db = (await import('$lib/server/db')).getDb(t.env);
		const on = await writeIssueConsent(db, t.env, session, issueId, {
			value: 'on',
			expected_revision: 0,
			issue_epoch: 0,
			decision_revision: 0,
			disclosure_version: 1
		});
		expect(on.my_agents).toMatchObject({
			value: 'on',
			source: 'explicit_issue',
			revision: 1,
			epoch: 0
		});
		expect(t.all('SELECT * FROM personal_disclosure WHERE user_id = ?', USER)).toHaveLength(1);
		await expect(
			writeIssueConsent(db, t.env, session, issueId, {
				value: 'off',
				expected_revision: 0,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 409, code: 'conflict' });
		const off = await writeIssueConsent(db, t.env, session, issueId, {
			value: 'off',
			expected_revision: 1,
			issue_epoch: 0,
			decision_revision: 0
		});
		expect(off.my_agents).toMatchObject({ value: 'off', revision: 2 });
		expect((await readIssueConsent(db, USER, issueId)).my_agents.value).toBe('off');
	});

	it('does not allow a run key to write the session-only endpoint', async () => {
		const { t, issueId } = sharedIssue();
		const db = (await import('$lib/server/db')).getDb(t.env);
		const key = { ...session, apiKeyId: 'key_named', apiKeyName: 'automation', viaSession: false };
		await expect(
			writeIssueConsent(db, t.env, key, issueId, {
				value: 'on',
				expected_revision: 0,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 403, code: 'consent_browser_required' });
		expect(t.all('SELECT * FROM issue_personal_choice')).toHaveLength(0);
	});

	it('treats Bearer plus cookie as key input for consent and disables implicit grants', async () => {
		const { t } = sharedIssue();
		const mixed = { ...session, bearerPresent: true };
		await expect(
			createIssue(t.db, t.env, mixed, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
				title: 'refused',
				allow_my_agents: false
			})
		).rejects.toMatchObject({
			status: 403,
			code: 'consent_browser_required'
		});
		const created = await createIssue(t.db, t.env, mixed, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'unset'
		});
		expect(
			t.all('SELECT * FROM issue_personal_choice WHERE issue_id = ?', created.id)
		).toHaveLength(0);
		await expect(
			writeIssueConsent(t.db, t.env, mixed, created.id, {
				value: 'on',
				expected_revision: 0,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 403, code: 'consent_browser_required' });
	});

	it('forced Done resets a choice and reopening cannot restore it', async () => {
		const { t, issueId } = sharedIssue();
		await writeIssueConsent(t.db, t.env, session, issueId, {
			value: 'on',
			expected_revision: 0,
			issue_epoch: 0,
			decision_revision: 0
		});
		await updateIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, issueId, {
			state: 'Closed'
		});
		const done = await readIssueConsent(t.db, USER, issueId);
		expect(done.my_agents).toMatchObject({ value: 'unset', revision: 2, epoch: 1 });
		await updateIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, issueId, { state: 'Open' });
		const reopened = await readIssueConsent(t.db, USER, issueId);
		expect(reopened.my_agents).toMatchObject({ value: 'unset', revision: 3, epoch: 2 });
		await expect(
			writeIssueConsent(t.db, t.env, session, issueId, {
				value: 'on',
				expected_revision: 1,
				issue_epoch: 0,
				decision_revision: 0
			})
		).rejects.toMatchObject({ status: 409 });
	});

	it('hold releases assigned work without a strike and uses a revisioned release', async () => {
		const { t, issueId } = sharedIssue();
		const runner = addRunner(t);
		const runId = addRun(t, { issueId, runnerId: runner });
		const db = (await import('$lib/server/db')).getDb(t.env);
		const held = await writeIssueHold(db, t.env, session, issueId, {
			held: true,
			expected_revision: 0
		});
		expect(held).toMatchObject({ held: true, revision: 1, released_assigned: 1 });
		expect(runById(t, runId)).toMatchObject({ status: 'canceled', outcome: null });
		expect(issueById(t, issueId).attempt_count).toBe(0);
		const released = await writeIssueHold(db, t.env, session, issueId, {
			held: false,
			expected_revision: 1
		});
		expect(released).toMatchObject({ held: false, revision: 2, released_assigned: 0 });
		await expect(
			writeIssueHold(db, t.env, session, issueId, { held: true, expected_revision: 1 })
		).rejects.toMatchObject({ status: 409, code: 'conflict' });
	});
});

describe('personal permission notice acknowledgement', () => {
	it('records the current notice once for a browser session and grants nothing', async () => {
		const { t, issueId } = sharedIssue();
		const db = (await import('$lib/server/db')).getDb(t.env);
		expect(await acknowledgeDisclosure(db, session, { version: 1 })).toEqual({ version: 1 });
		expect(await acknowledgeDisclosure(db, session, { version: 1 })).toEqual({ version: 1 });
		expect(t.all('SELECT version FROM personal_disclosure WHERE user_id = ?', USER)).toEqual([
			{ version: 1 }
		]);
		expect(t.all('SELECT * FROM issue_personal_choice WHERE issue_id = ?', issueId)).toEqual([]);
	});

	it('refuses API keys and versions the browser does not show', async () => {
		const { t } = sharedIssue();
		const db = (await import('$lib/server/db')).getDb(t.env);
		const key = { ...session, apiKeyId: 'key_named', apiKeyName: 'automation', viaSession: false };
		await expect(acknowledgeDisclosure(db, key, { version: 1 })).rejects.toMatchObject({
			status: 403,
			code: 'consent_browser_required'
		});
		await expect(
			acknowledgeDisclosure(db, { ...session, bearerPresent: true }, { version: 1 })
		).rejects.toMatchObject({ status: 403, code: 'consent_browser_required' });
		for (const version of [2, 0, '1', undefined]) {
			await expect(acknowledgeDisclosure(db, session, { version })).rejects.toMatchObject({
				status: 422,
				code: 'invalid_field'
			});
		}
		expect(t.all('SELECT * FROM personal_disclosure WHERE user_id = ?', USER)).toEqual([]);
	});
});
