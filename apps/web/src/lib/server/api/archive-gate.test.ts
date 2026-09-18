/**
 * Every write that anchors on an archived project, and the drain exemption
 * that lets a run already under way finish its own issue. One row per write:
 * a session actor is always refused; the run key of an active run on *its
 * own* issue is allowed exactly where the design says it is (issue-anchored
 * writes only — never project-level ones, so `tines journal append` is
 * refused and the lesson goes in the handoff comment).
 *
 * Reads are never gated; the last block pins that.
 */
import { TEST_NOOP_DISPATCH_EFFECTS } from '$lib/server/api/test-dispatch-effects';
import { describe, expect, it, beforeEach } from 'vitest';
import { NOW, OPEN, PROJECT, USER, addRun, addRunner, seedBase } from '../supervisor/test-fixtures';
import { explainDispatch } from '../supervisor/explain';
import {
	artifactContentResponse,
	deleteArtifact,
	listArtifacts,
	reaffirmArtifact,
	upsertArtifact
} from './artifacts';
import {
	appendContextItem,
	createContextItem,
	deleteContextItem,
	effectiveContextForIssue,
	journalForIssue,
	updateContextItem
} from './context';
import { ApiFail, type ActorContext } from './core';
import { addIssueLink, removeIssueLink } from './issue-links';
import {
	createComment,
	createIssue,
	deleteComment,
	getIssueDetail,
	resumeIssue,
	transitionIssue,
	updateComment,
	updateIssue
} from './issues';
import { addIssueLabels, createLabel, removeIssueLabel } from './labels';
import { archiveProject } from './projects';
import { deleteSchedule, runScheduleNow, updateSchedule } from './schedules';
import { createTestDb, type TestDb } from './test-db';

const session: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

let t: TestDb;
/** The issue the draining run owns, and a second one it does not. */
let own: string;
let other: string;
let ownComment: string;
let scheduleId: string;
let projectItem: string;
let issueItem: string;
let linkId: string;
let liveIssue: string;
let draining: ActorContext;

/** Everything the gate is asked about, seeded while the project is still live. */
beforeEach(async () => {
	t = createTestDb();
	seedBase(t);
	// A second, live project: the far end of a cross-project link.
	t.sqlite.exec(`
		INSERT INTO project (id, user_id, name, created_at, updated_at)
			VALUES ('prj_2', '${USER}', 'live', ${NOW}, ${NOW});
	`);

	const created = await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
		title: 'Draining issue',
		schedule: { preset: { kind: 'daily', time: '09:00' } }
	});
	own = created.id;
	scheduleId = created.schedule!.id;
	other = (
		await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, {
			title: 'Second issue'
		})
	).id;

	await upsertArtifact(t.db, t.env, session, own, 'notes', { type: 'text', content: 'seeded' });
	await createLabel(t.db, t.env, session, { name: 'docs' });
	await createLabel(t.db, t.env, session, { name: 'qa' });
	liveIssue = (
		await createIssue(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, 'prj_2', {
			title: 'Live issue'
		})
	).id;
	// The removable link points at the live project: with the archived end
	// exempt for the run, only its own end is under test here.
	linkId = (
		await addIssueLink(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, own, {
			kind: 'blocks',
			issue_id: liveIssue
		})
	).id;
	await addIssueLabels(t.db, t.env, session, TEST_NOOP_DISPATCH_EFFECTS, own, ['docs']);
	projectItem = (
		await createContextItem(t.db, t.env, session, {
			kind: 'prompt',
			name: 'conventions',
			project_id: PROJECT,
			body: 'house style'
		})
	).id;
	issueItem = (
		await createContextItem(t.db, t.env, session, {
			kind: 'prompt',
			name: 'issue-note',
			issue_id: own,
			body: 'for this issue only'
		})
	).id;

	await archiveProject(t.db, t.env, session, PROJECT, NOW);

	// The run was launched before the archive — the only way one can exist.
	const runId = addRun(t, {
		issueId: own,
		runnerId: addRunner(t),
		status: 'running',
		stateAtStart: OPEN
	});
	// The event writer has a foreign key to api_key, so the run's key must exist.
	t.sqlite.exec(`
		INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, agent_run_id, expires_at, created_at)
			VALUES ('key_${runId}', '${USER}', 'run ${runId}', 'h_${runId}', 'p', '${runId}', 9999999999999, 0);
	`);
	draining = {
		userId: USER,
		userName: 'alice',
		apiKeyId: `key_${runId}`,
		apiKeyName: `run ${runId}`,
		viaSession: false,
		agentRunId: runId
	};
	// A comment the run authored: run keys may only edit their own, so the
	// author check must not stand in for the gate in the rows below.
	ownComment = (await createComment(t.db, t.env, draining, own, { body: 'from the run' })).id;
});

async function failure(fn: () => Promise<unknown>): Promise<ApiFail> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ApiFail) return e;
		throw e;
	}
	throw new Error('expected the call to throw');
}

const refused = async (fn: () => Promise<unknown>) =>
	expect((await failure(fn)).code).toBe('project_archived');

/**
 * Each row is the same write twice: once as the operator (always refused) and
 * once as the draining run on its own issue (`drains` says which it gets).
 */
interface Row {
	name: string;
	/** The write, as the given actor, on the run's own issue where there is one. */
	write: (actor: ActorContext) => Promise<unknown>;
	/** True when the drain exemption covers it. */
	drains: boolean;
}

const rows = (): Row[] => [
	{
		name: 'create issue',
		write: (a) =>
			createIssue(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, PROJECT, { title: 'New' }),
		drains: false
	},
	{
		name: 'update issue',
		write: (a) =>
			updateIssue(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, { title: 'Renamed' }),
		drains: true
	},
	{
		name: 'transition issue',
		write: (a) =>
			transitionIssue(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, {
				action: 'Submit for review'
			}),
		drains: true
	},
	{
		name: 'resume issue',
		write: (a) => resumeIssue(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own),
		drains: true
	},
	{
		name: 'create comment',
		write: (a) => createComment(t.db, t.env, a, own, { body: 'hello' }),
		drains: true
	},
	{
		name: 'update comment',
		write: (a) => updateComment(t.db, t.env, a, own, ownComment, { body: 'edited' }),
		drains: true
	},
	{
		name: 'delete comment',
		write: (a) => deleteComment(t.db, t.env, a, own, ownComment),
		drains: true
	},
	{
		name: 'upsert artifact',
		write: (a) => upsertArtifact(t.db, t.env, a, own, 'notes', { type: 'text', content: 'more' }),
		drains: true
	},
	{
		name: 'reaffirm artifact',
		write: (a) => reaffirmArtifact(t.db, t.env, a, own, 'notes'),
		drains: true
	},
	{
		name: 'delete artifact',
		write: (a) => deleteArtifact(t.db, t.env, a, own, 'notes'),
		drains: true
	},
	{
		name: 'add label',
		write: (a) => addIssueLabels(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, ['qa']),
		drains: true
	},
	{
		name: 'remove label',
		write: (a) => removeIssueLabel(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, 'docs'),
		drains: true
	},
	{
		// The far end is live, so only the run's own (archived) end is in play.
		name: 'add link',
		write: (a) =>
			addIssueLink(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, {
				kind: 'duplicate_of',
				issue_id: liveIssue
			}),
		drains: true
	},
	{
		name: 'remove link',
		write: (a) => removeIssueLink(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, own, linkId),
		drains: true
	},
	{
		name: 'create project-scoped context',
		write: (a) =>
			createContextItem(t.db, t.env, a, {
				kind: 'prompt',
				name: 'journal',
				project_id: PROJECT,
				body: '- a lesson'
			}),
		drains: false
	},
	{
		name: 'append to a project-scoped prompt (journal append)',
		write: (a) => appendContextItem(t.db, t.env, a, projectItem, { text: '- a lesson' }),
		drains: false
	},
	{
		name: 'update a project-scoped context item',
		write: (a) => updateContextItem(t.db, t.env, a, projectItem, { body: 'rewritten' }),
		drains: false
	},
	{
		name: 'delete a project-scoped context item',
		write: (a) => deleteContextItem(t.db, t.env, a, projectItem),
		drains: false
	},
	{
		// Issue-scoped context is the run's own issue, so the drain covers it.
		name: 'update an issue-scoped context item',
		write: (a) => updateContextItem(t.db, t.env, a, issueItem, { body: 'rewritten' }),
		drains: true
	},
	{
		name: 'edit schedule',
		write: (a) => updateSchedule(t.db, t.env, a, scheduleId, { title_template: 'Nope' }),
		drains: false
	},
	{
		name: 'run schedule now',
		write: (a) => runScheduleNow(t.db, t.env, a, TEST_NOOP_DISPATCH_EFFECTS, scheduleId),
		drains: false
	},
	{
		name: 'delete schedule',
		write: (a) => deleteSchedule(t.db, t.env, a, scheduleId),
		drains: false
	}
];

describe('an archived project refuses every write', () => {
	for (const row of rows()) {
		it(`refuses ${row.name}`, async () => {
			await refused(() => row.write(session));
		});
	}
});

describe('a run already draining finishes its own issue', () => {
	for (const row of rows()) {
		if (row.drains) {
			it(`lets the run ${row.name}`, async () => {
				// A throw fails the test; the gate is what would throw.
				await row.write(draining);
			});
		} else {
			it(`still refuses the run ${row.name}`, async () => {
				await refused(() => row.write(draining));
			});
		}
	}

	it("refuses the run's writes on another issue in the project", async () => {
		await refused(() => createComment(t.db, t.env, draining, other, { body: 'not mine' }));
	});

	it('refuses a link whose *other* end is in the archived project', async () => {
		// The addressed issue is live and not the run's, so nothing exempts the
		// far end: both ends are gated, not just the one in the URL.
		await refused(() =>
			addIssueLink(t.db, t.env, draining, TEST_NOOP_DISPATCH_EFFECTS, liveIssue, {
				kind: 'blocks',
				issue_id: other
			})
		);
	});
});

describe('reads are never gated', () => {
	it('serves the issue, its artifacts, its context and its journal', async () => {
		const detail = await getIssueDetail(t.db, USER, { id: own });
		expect(detail.project_archived_at).toBe(NOW);
		expect((await listArtifacts(t.db, USER, own)).length).toBeGreaterThan(0);
		await expect(artifactContentResponse(t.db, t.env, USER, own, 'notes')).resolves.toBeDefined();
		await expect(effectiveContextForIssue(t.db, USER, own)).resolves.toBeDefined();
		await expect(journalForIssue(t.db, session, own)).resolves.toBeDefined();
	});

	it('explains why nothing dispatches', async () => {
		const explain = await explainDispatch(t.db, USER, own);
		const check = explain?.checks.find((c) => c.name === 'project_archived');
		expect(check?.ok).toBe(false);
		expect(check?.detail).toContain('archived');
		expect(explain?.eligible).toBe(false);
	});
});
