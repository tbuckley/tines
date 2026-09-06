/**
 * The handoff derivations, over the real schema: the round that came back and
 * the human steer that starts the next one. The headline scenario is Tines/29's
 * shape — Research → Design → Implementation → Automated Review (failed) →
 * Implementation → Automated Review (passed) — because the two Implementation
 * runs are what the folding rule exists for.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	ENG_STATES,
	NOW,
	PROJECT,
	USER,
	addComment,
	addEngineeringWorkflow,
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	addTransitionEvent,
	seedBase
} from '../supervisor/test-fixtures';
import { getIssueDetail, listIssues } from './issues';
import { createTestDb, type TestDb } from './test-db';

let t: TestDb;
let runnerId: string;

/** One artifact item on an issue; versions are added by `addVersion`. */
function addArtifact(issueId: string, name: string, artifactType: string): string {
	const id = `ctx_${name}_${issueId}`;
	t.sqlite
		.prepare(
			`INSERT INTO context_item (id, user_id, kind, name, description, issue_id, config,
				position, version, created_at, updated_at)
			VALUES (?, ?, 'artifact', ?, '', ?, ?, 0, 1, ?, ?)`
		)
		.run(id, USER, name, issueId, JSON.stringify({ artifact_type: artifactType }), NOW, NOW);
	return id;
}

let versionSeq = 0;

function addVersion(
	itemId: string,
	version: number,
	opts: { apiKeyId?: string | null; at: number; pr?: [string, number]; files?: string[] }
): string {
	const id = `av_${++versionSeq}`;
	t.sqlite
		.prepare(
			`INSERT INTO artifact_version (id, context_item_id, version, pr_repo_url, pr_number,
				actor_user_id, actor_api_key_id, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			itemId,
			version,
			opts.pr?.[0] ?? null,
			opts.pr?.[1] ?? null,
			USER,
			opts.apiKeyId ?? null,
			opts.at
		);
	for (const path of opts.files ?? []) {
		t.sqlite
			.prepare(
				`INSERT INTO artifact_version_file (id, artifact_version_id, path, content_type, size_bytes, r2_key)
				VALUES (?, ?, ?, 'image/png', 1, ?)`
			)
			.run(`avf_${path}_${id}`, id, path, `r2/${id}/${path}`);
	}
	return id;
}

/** A finished run with its run key, and the transition it took. */
function finishedRun(opts: {
	id: string;
	issueId: string;
	from: string;
	to: string;
	action: string;
	fromName: string;
	toName: string;
	at: number;
}): string {
	addRun(t, {
		id: opts.id,
		issueId: opts.issueId,
		runnerId,
		status: 'completed',
		stateAtStart: opts.from,
		stateAtEnd: opts.to,
		outcome: 'advanced',
		createdAt: opts.at,
		startedAt: opts.at,
		endedAt: opts.at + 600_000
	});
	const keyId = addRunKey(t, opts.id);
	addTransitionEvent(t, {
		issueId: opts.issueId,
		apiKeyId: keyId,
		at: opts.at + 600_000,
		from: opts.from,
		to: opts.to,
		action: opts.action,
		fromName: opts.fromName,
		toName: opts.toName
	});
	return keyId;
}

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	addEngineeringWorkflow(t);
	runnerId = addRunner(t, { name: 'macbook' });
});

/**
 * Tines/29's shape, ending in Human Review with the two Implementation runs
 * that make stage folding observable.
 */
function seedTines29(): string {
	const issueId = addIssue(t, {
		workflow: 'wf_eng',
		state: ENG_STATES.humanReview,
		title: 'Ship the thing'
	});
	const h = 3_600_000;
	const stages: {
		id: string;
		from: string;
		to: string;
		action: string;
		fromName: string;
		toName: string;
	}[] = [
		{
			id: 'arun_research',
			from: ENG_STATES.research,
			to: ENG_STATES.design,
			action: 'Research complete',
			fromName: 'Research',
			toName: 'Design'
		},
		{
			id: 'arun_design',
			from: ENG_STATES.design,
			to: ENG_STATES.impl,
			action: 'Design complete',
			fromName: 'Design',
			toName: 'Implementation'
		},
		{
			id: 'arun_impl1',
			from: ENG_STATES.impl,
			to: ENG_STATES.autoReview,
			action: 'Submit for automated review',
			fromName: 'Implementation',
			toName: 'Automated Review'
		},
		{
			id: 'arun_review1',
			from: ENG_STATES.autoReview,
			to: ENG_STATES.impl,
			action: 'Review failed',
			fromName: 'Automated Review',
			toName: 'Implementation'
		},
		{
			id: 'arun_impl2',
			from: ENG_STATES.impl,
			to: ENG_STATES.autoReview,
			action: 'Submit for automated review',
			fromName: 'Implementation',
			toName: 'Automated Review'
		},
		{
			id: 'arun_review2',
			from: ENG_STATES.autoReview,
			to: ENG_STATES.humanReview,
			action: 'Automated review passed',
			fromName: 'Automated Review',
			toName: 'Human Review'
		}
	];
	const keys = new Map<string, string>();
	stages.forEach((s, i) => {
		keys.set(s.id, finishedRun({ ...s, issueId, at: NOW + (i + 1) * h }));
	});
	// The second Implementation run posts three comments: the last is its
	// summary, the two before it fold to ids.
	addComment(t, {
		issueId,
		body: 'in progress',
		apiKeyId: keys.get('arun_impl2')!,
		at: NOW + 5 * h + 1,
		id: 'cmt_impl2_a'
	});
	addComment(t, {
		issueId,
		body: 'still going',
		apiKeyId: keys.get('arun_impl2')!,
		at: NOW + 5 * h + 2,
		id: 'cmt_impl2_b'
	});
	addComment(t, {
		issueId,
		body: 'Implementation (round 2) — the fix',
		apiKeyId: keys.get('arun_impl2')!,
		at: NOW + 5 * h + 3,
		id: 'cmt_impl2_c'
	});
	addComment(t, {
		issueId,
		body: 'Review passed',
		apiKeyId: keys.get('arun_review2')!,
		at: NOW + 6 * h + 1,
		id: 'cmt_review2'
	});

	// A comment left on this issue by a run working a *different* issue: in the
	// thread, but in no round entry.
	const otherIssue = addIssue(t, { workflow: 'wf_eng', state: ENG_STATES.impl });
	addRun(t, {
		id: 'arun_other',
		issueId: otherIssue,
		runnerId,
		status: 'completed',
		stateAtStart: ENG_STATES.impl,
		createdAt: NOW + 5 * h
	});
	const otherKey = addRunKey(t, 'arun_other');
	addComment(t, {
		issueId,
		body: 'drive-by from another issue',
		apiKeyId: otherKey,
		at: NOW + 5 * h + 4,
		id: 'cmt_stray'
	});

	// Artifacts: impl-pr created then reaffirmed, review-notes v1 then v2, a
	// screenshots folder from the passing review run.
	const pr = addArtifact(issueId, 'impl-pr', 'pr');
	addVersion(pr, 1, {
		apiKeyId: keys.get('arun_impl1')!,
		at: NOW + 3 * h + 1,
		pr: ['https://github.com/tbuckley/tines', 78]
	});
	addVersion(pr, 2, {
		apiKeyId: keys.get('arun_impl2')!,
		at: NOW + 5 * h + 1,
		pr: ['https://github.com/tbuckley/tines', 78]
	});
	const notes = addArtifact(issueId, 'review-notes', 'text');
	addVersion(notes, 1, { apiKeyId: keys.get('arun_review1')!, at: NOW + 4 * h + 1 });
	addVersion(notes, 2, { apiKeyId: keys.get('arun_review2')!, at: NOW + 6 * h + 1 });
	const shots = addArtifact(issueId, 'screenshots', 'folder');
	addVersion(shots, 1, {
		apiKeyId: keys.get('arun_review2')!,
		at: NOW + 6 * h + 2,
		files: ['a.png', 'b.png']
	});
	// A version attached to this issue by that same other-issue run: the
	// version half of the attribution guard the stray comment covers.
	const stray = addArtifact(issueId, 'stray-notes', 'text');
	addVersion(stray, 1, { apiKeyId: otherKey, at: NOW + 5 * h + 5 });
	return issueId;
}

describe('round', () => {
	it('groups the round by stage in workflow order, latest run leading', async () => {
		const issueId = seedTines29();
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const round = detail.round!;
		expect(round.stages.map((s) => s.state.name)).toEqual([
			'Research',
			'Design',
			'Implementation',
			'Automated Review'
		]);
		expect(round.run_count).toBe(6);
		// The issue has never been transitioned by a human, so the round starts
		// at its creation.
		expect(round.boundary).toBeNull();
		expect(round.boundary_at).toBe(NOW);

		const impl = round.stages.find((s) => s.state.name === 'Implementation')!;
		expect(impl.runs.map((r) => r.run_id)).toEqual(['arun_impl2', 'arun_impl1']);
		// The earlier attempt names the transition that ended it.
		expect(impl.runs[1].returned_via?.action).toBe('Review failed');
		expect(impl.runs[1].returned_via?.from_state.name).toBe('Automated Review');
		expect(impl.runs[0].returned_via).toBeNull();
	});

	it('folds in neither the comment nor the artifact version of a run working another issue', async () => {
		const issueId = seedTines29();
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const entries = detail.round!.stages.flatMap((s) => s.runs);
		expect(entries.map((r) => r.run_id)).not.toContain('arun_other');
		expect(entries.flatMap((r) => r.artifacts.map((a) => a.name))).not.toContain('stray-notes');
		expect(entries.flatMap((r) => r.earlier_comment_ids)).not.toContain('cmt_stray');
		expect(entries.map((r) => r.summary_comment?.id)).not.toContain('cmt_stray');
		// The row summary applies the same guard by issue id.
		const { items } = await listIssues(t.db, USER, {}, { limit: 20, cursor: null });
		expect(
			items.find((i) => i.id === issueId)!.round_summary?.artifacts.map((a) => a.name)
		).not.toContain('stray-notes');
	});

	it('sorts stages by workflow position, not by when the round first reached them', async () => {
		// A round that moves *backwards*: Implementation → Automated Review →
		// Design → Human Review. First-seen order is Implementation, Automated
		// Review, Design — so only a position sort produces workflow order.
		const issueId = addIssue(t, { workflow: 'wf_eng', state: ENG_STATES.humanReview });
		const h = 3_600_000;
		finishedRun({
			id: 'arun_i',
			issueId,
			from: ENG_STATES.impl,
			to: ENG_STATES.autoReview,
			action: 'Submit for automated review',
			fromName: 'Implementation',
			toName: 'Automated Review',
			at: NOW + h
		});
		finishedRun({
			id: 'arun_ar',
			issueId,
			from: ENG_STATES.autoReview,
			to: ENG_STATES.design,
			action: 'Design unworkable',
			fromName: 'Automated Review',
			toName: 'Design',
			at: NOW + 2 * h
		});
		finishedRun({
			id: 'arun_d',
			issueId,
			from: ENG_STATES.design,
			to: ENG_STATES.humanReview,
			action: 'Design complete',
			fromName: 'Design',
			toName: 'Human Review',
			at: NOW + 3 * h
		});
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		expect(detail.round!.stages.map((s) => s.state.name)).toEqual([
			'Design',
			'Implementation',
			'Automated Review'
		]);
	});

	it('carries each run its summary comment, folded earlier ids and artifact versions', async () => {
		const issueId = seedTines29();
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const impl2 = detail.round!.stages.find((s) => s.state.name === 'Implementation')!.runs[0];
		expect(impl2.summary_comment).toMatchObject({
			id: 'cmt_impl2_c',
			body: 'Implementation (round 2) — the fix'
		});
		expect(impl2.earlier_comment_ids).toEqual(['cmt_impl2_a', 'cmt_impl2_b']);
		expect(impl2.artifacts).toEqual([
			{
				name: 'impl-pr',
				artifact_type: 'pr',
				from_version: 1,
				to_version: 2,
				pr_url: 'https://github.com/tbuckley/tines/pull/78',
				files: null
			}
		]);
		expect(impl2.transition?.action).toBe('Submit for automated review');

		const review2 = detail.round!.stages.find((s) => s.state.name === 'Automated Review')!.runs[0];
		const shots = review2.artifacts.find((a) => a.name === 'screenshots')!;
		expect(shots.files).toEqual(['a.png', 'b.png']);
		expect(review2.artifacts.find((a) => a.name === 'review-notes')).toMatchObject({
			from_version: 1,
			to_version: 2
		});
	});

	it('never folds a comment left by a run working another issue', async () => {
		const issueId = seedTines29();
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const ids = detail.round!.stages.flatMap((s) =>
			s.runs.flatMap((r) => [r.summary_comment?.id, ...r.earlier_comment_ids])
		);
		expect(ids).not.toContain('cmt_stray');
		// It is still in the thread — this is an exclusion from the round, not
		// from the issue.
		expect(detail.comments.map((c) => c.id)).toContain('cmt_stray');
	});

	it('is absent unless the caller opts in, and null when a human moved the issue here', async () => {
		const issueId = seedTines29();
		const plain = await getIssueDetail(t.db, USER, { id: issueId });
		expect('round' in plain).toBe(false);

		const fresh = addIssue(t, { workflow: 'wf_eng', state: ENG_STATES.humanReview });
		addTransitionEvent(t, {
			issueId: fresh,
			apiKeyId: null,
			at: NOW + 100,
			from: ENG_STATES.impl,
			to: ENG_STATES.humanReview,
			action: 'Needs a look',
			fromName: 'Implementation',
			toName: 'Human Review'
		});
		const detail = await getIssueDetail(t.db, USER, { id: fresh }, { round: true });
		expect(detail.round).toBeNull();
	});

	it('starts the round after the last human-taken transition', async () => {
		const issueId = seedTines29();
		const h = 3_600_000;
		// A human sends it back, then one more run works it.
		addTransitionEvent(t, {
			issueId,
			apiKeyId: null,
			at: NOW + 7 * h,
			from: ENG_STATES.humanReview,
			to: ENG_STATES.impl,
			action: 'Send back to implementation',
			fromName: 'Human Review',
			toName: 'Implementation'
		});
		finishedRun({
			id: 'arun_impl3',
			issueId,
			from: ENG_STATES.impl,
			to: ENG_STATES.humanReview,
			action: 'Submit for automated review',
			fromName: 'Implementation',
			toName: 'Human Review',
			at: NOW + 8 * h
		});
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		expect(detail.round!.run_count).toBe(1);
		expect(detail.round!.boundary?.action).toBe('Send back to implementation');
		expect(detail.round!.stages.flatMap((s) => s.runs.map((r) => r.run_id))).toEqual([
			'arun_impl3'
		]);
	});

	it('treats a forced move as a boundary, naming no action', async () => {
		const issueId = seedTines29();
		const h = 3_600_000;
		// `issues edit -s` moves an issue without an action: still the human
		// acting, so it still opens a new round.
		addTransitionEvent(t, {
			issueId,
			apiKeyId: null,
			at: NOW + 7 * h,
			from: ENG_STATES.humanReview,
			to: ENG_STATES.impl,
			action: null,
			fromName: 'Human Review',
			toName: 'Implementation',
			forced: true
		});
		finishedRun({
			id: 'arun_after_force',
			issueId,
			from: ENG_STATES.impl,
			to: ENG_STATES.humanReview,
			action: 'Submit for automated review',
			fromName: 'Implementation',
			toName: 'Human Review',
			at: NOW + 8 * h
		});
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		expect(detail.round!.boundary).toMatchObject({ action: null, at: NOW + 7 * h });
		expect(detail.round!.run_count).toBe(1);
	});

	it('does not treat a workflow change as a boundary, and stops claiming how the issue arrived', async () => {
		const issueId = seedTines29();
		const h = 3_600_000;
		// A workflow change re-stamps state_entered_at and emits issue.updated,
		// never issue.transitioned: the round it interrupts is unchanged, but
		// nothing transitioned the issue into where it now sits.
		t.sqlite
			.prepare(`UPDATE issue SET state_entered_at = ? WHERE id = ?`)
			.run(NOW + 7 * h, issueId);
		t.sqlite
			.prepare(
				`INSERT INTO event (id, user_id, type, actor_user_id, actor_api_key_id, issue_id, project_id, payload, created_at)
				VALUES ('evt_wfchange', ?, 'issue.updated', ?, NULL, ?, ?, '{"workflow_id":"wf_eng"}', ?)`
			)
			.run(USER, USER, issueId, PROJECT, NOW + 7 * h);

		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		expect(detail.round!.run_count).toBe(6);
		expect(detail.round!.boundary).toBeNull();
		const { items } = await listIssues(t.db, USER, {}, { limit: 20, cursor: null });
		expect(items.find((i) => i.id === issueId)!.arrived_via).toBeNull();
	});
});

describe('since_last_run', () => {
	it('reports the human transition, their comments and what went stale', async () => {
		const issueId = seedTines29();
		const h = 3_600_000;
		// The human's move re-stamps state_entered_at, which is what makes the
		// artifacts attached in Human Review's predecessor stale.
		t.sqlite
			.prepare(`UPDATE issue SET state_id = ?, state_entered_at = ? WHERE id = ?`)
			.run(ENG_STATES.impl, NOW + 7 * h, issueId);
		addTransitionEvent(t, {
			issueId,
			apiKeyId: null,
			at: NOW + 7 * h,
			from: ENG_STATES.humanReview,
			to: ENG_STATES.impl,
			action: 'Send back to implementation',
			fromName: 'Human Review',
			toName: 'Implementation'
		});
		addComment(t, {
			issueId,
			body: 'CI is red on the e2e job',
			apiKeyId: null,
			at: NOW + 7 * h + 1,
			id: 'cmt_human'
		});

		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const since = detail.since_last_run!;
		expect(since.previous_run.run_id).toBe('arun_review2');
		expect(since.transition?.from_state.name).toBe('Human Review');
		expect(since.transition?.action).toBe('Send back to implementation');
		expect(since.comments.map((c) => c.id)).toEqual(['cmt_human']);
		expect(since.comment_count).toBe(1);
		// Everything the round produced is stale now that the issue has moved.
		// Freshness is a property of the artifact on this issue, so the version a
		// run working another issue attached counts here — unlike in `round`,
		// which reports what *this* issue's runs produced.
		expect(since.stale_artifacts).toEqual([
			'impl-pr',
			'review-notes',
			'screenshots',
			'stray-notes'
		]);
	});

	it('is null when nothing human happened after the previous run', async () => {
		const issueId = seedTines29();
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		expect(detail.since_last_run).toBeNull();
	});

	it('is present with a null transition on a comment-only steer, and caps at ten comments', async () => {
		const issueId = seedTines29();
		const h = 3_600_000;
		for (let i = 0; i < 11; i += 1) {
			addComment(t, {
				issueId,
				body: `note ${i}`,
				apiKeyId: null,
				at: NOW + 7 * h + i,
				id: `cmt_h${i}`
			});
		}
		const detail = await getIssueDetail(t.db, USER, { id: issueId }, { round: true });
		const since = detail.since_last_run!;
		expect(since.transition).toBeNull();
		expect(since.comment_count).toBe(11);
		expect(since.comments).toHaveLength(10);
		// The newest ten, oldest first: the very first note is the one dropped.
		expect(since.comments[0].id).toBe('cmt_h1');
		expect(since.stale_artifacts).toEqual([]);
	});

	// The three shapes the launch prompt's steer section exists for. They differ
	// only in which awaiting state the human acted from; the rendering is pinned
	// once in context.test.ts and end to end in runner-protocol.test.ts.
	it.each([
		['sent back from Human Review', ENG_STATES.humanReview, 'Send back to implementation'],
		['reworked from PRD Review', ENG_STATES.autoReview, 'Rework the PRD'],
		['answered from Needs Clarification', ENG_STATES.autoReview, 'Answer']
	])('carries a steer %s', async (_label, fromState, action) => {
		const issueId = seedTines29();
		const h = 3_600_000;
		t.sqlite
			.prepare(`UPDATE issue SET state_id = ?, state_entered_at = ? WHERE id = ?`)
			.run(ENG_STATES.impl, NOW + 7 * h, issueId);
		addTransitionEvent(t, {
			issueId,
			apiKeyId: null,
			at: NOW + 7 * h,
			from: fromState,
			to: ENG_STATES.impl,
			action,
			fromName: 'Awaiting',
			toName: 'Implementation'
		});
		addComment(t, { issueId, body: 'here is the answer', apiKeyId: null, at: NOW + 7 * h + 1 });

		const since = (await getIssueDetail(t.db, USER, { id: issueId }, { round: true }))
			.since_last_run!;
		expect(since.transition?.action).toBe(action);
		expect(since.transition?.from_state.id).toBe(fromState);
		expect(since.comments.map((c) => c.body)).toEqual(['here is the answer']);
	});

	it('is null when the issue has never had a finished run', async () => {
		const fresh = addIssue(t, { workflow: 'wf_eng', state: ENG_STATES.impl });
		addComment(t, { issueId: fresh, body: 'go', apiKeyId: null, at: NOW + 10 });
		const detail = await getIssueDetail(t.db, USER, { id: fresh }, { round: true });
		expect(detail.since_last_run).toBeNull();
	});
});

describe('list rows', () => {
	it('carries state_entered_at, arrived_via and round_summary on awaiting-human rows only', async () => {
		const awaitingId = seedTines29();
		const activeId = addIssue(t, { workflow: 'wf_eng', state: ENG_STATES.impl });
		const { items } = await listIssues(t.db, USER, {}, { limit: 20, cursor: null });
		const awaiting = items.find((i) => i.id === awaitingId)!;
		const active = items.find((i) => i.id === activeId)!;

		expect(awaiting.arrived_via).toMatchObject({
			action: 'Automated review passed',
			from_state_name: 'Automated Review',
			by_run: true
		});
		expect(awaiting.round_summary?.pr_url).toBe('https://github.com/tbuckley/tines/pull/78');
		expect(awaiting.round_summary?.artifacts).toEqual([
			{ name: 'impl-pr', artifact_type: 'pr', version: 2 },
			{ name: 'review-notes', artifact_type: 'text', version: 2 },
			{ name: 'screenshots', artifact_type: 'folder', version: 1 }
		]);
		expect(active.arrived_via).toBeNull();
		expect(active.round_summary).toBeNull();
	});

	it('leaves state_entered_at alone when a comment arrives', async () => {
		const issueId = seedTines29();
		const before = (await listIssues(t.db, USER, {}, { limit: 20, cursor: null })).items.find(
			(i) => i.id === issueId
		)!.state_entered_at;
		addComment(t, { issueId, body: 'a thought', apiKeyId: null, at: NOW + 9_000_000 });
		const after = (await listIssues(t.db, USER, {}, { limit: 20, cursor: null })).items.find(
			(i) => i.id === issueId
		)!.state_entered_at;
		expect(after).toBe(before);
	});
});
