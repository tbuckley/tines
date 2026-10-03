import {
	ApiError,
	type PrepareWorkflowPackageResponse,
	type PublicSnapshotStatus,
	type PublicWorkflowSnapshot,
	type WorkflowPackageDocument
} from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	createHostedInstallSession,
	type HostedInstallState,
	type HostedInstallTransport
} from './hosted-install-session';

const SNAPSHOT_ID = 'pub_snapshot';
const CHOICES = { schedule_ids: [] };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function status(version = 1, publisher = 0): PublicSnapshotStatus {
	return { available: true, status_version: version, publisher_status_version: publisher };
}
function snapshot(version = 1, digest = 'sha256:one'): PublicWorkflowSnapshot {
	return {
		snapshot_id: SNAPSHOT_ID,
		status_version: version,
		document: { digest } as WorkflowPackageDocument
	} as PublicWorkflowSnapshot;
}
function planFor(id: string, version = 1, publisher = 0): PrepareWorkflowPackageResponse {
	return {
		plan_id: id,
		source: {
			kind: 'hosted_publication',
			snapshot_id: SNAPSHOT_ID,
			snapshot_status_version: version,
			publisher_status_version: publisher
		}
	} as PrepareWorkflowPackageResponse;
}
const unavailable = () =>
	new ApiError(404, { code: 'publication_unavailable', message: 'Not available' }, 'Not available');

/** Each request waits in a queue until the test settles it, so interleavings are explicit. */
function harness() {
	const statuses: Array<ReturnType<typeof deferred<PublicSnapshotStatus>>> = [];
	const snapshots: Array<ReturnType<typeof deferred<PublicWorkflowSnapshot>>> = [];
	const prepares: Array<ReturnType<typeof deferred<PrepareWorkflowPackageResponse>>> = [];
	const transport: HostedInstallTransport = {
		getStatus: () => {
			const held = deferred<PublicSnapshotStatus>();
			statuses.push(held);
			return held.promise;
		},
		getSnapshot: () => {
			const held = deferred<PublicWorkflowSnapshot>();
			snapshots.push(held);
			return held.promise;
		},
		prepare: () => {
			const held = deferred<PrepareWorkflowPackageResponse>();
			prepares.push(held);
			return held.promise;
		}
	};
	const changes: HostedInstallState[] = [];
	const session = createHostedInstallSession(SNAPSHOT_ID, transport, (next) => changes.push(next));
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return { session, statuses, snapshots, prepares, changes, settle };
}

async function loaded() {
	const h = harness();
	const loading = h.session.load();
	h.statuses[0].resolve(status());
	await h.settle();
	h.snapshots[0].resolve(snapshot());
	await loading;
	expect(h.session.state).toMatchObject({ availability: 'available', phase: 'idle' });
	return h;
}

async function prepared() {
	const h = await loaded();
	const preparing = h.session.prepare(CHOICES);
	const plan = planFor('plan_one');
	h.prepares[0].resolve(plan);
	expect(await preparing).toEqual({ kind: 'prepared', plan });
	expect(h.session.state).toMatchObject({ phase: 'prepared', plan });
	return { ...h, plan };
}

describe('hosted install session', () => {
	it('acquires the document once and records the version it belongs to', async () => {
		const h = await loaded();
		expect(h.session.state.version).toEqual({ snapshot: 1, publisher: 0 });
		expect(h.session.state.document?.digest).toBe('sha256:one');
		expect(h.statuses).toHaveLength(1);
		expect(h.snapshots).toHaveLength(1);
	});

	it('keeps the prepared plan and both epochs through an unchanged successful recheck', async () => {
		const h = await prepared();
		const before = h.session.state;
		const emitted = h.changes.length;
		void h.session.recheck();
		h.statuses[1].resolve(status());
		// Settle rather than await the check, so a recheck that starts a reload fails here by assertion.
		await h.settle();
		// Identity, not equality: nothing was reassigned, so the page has nothing to reset.
		expect(h.session.state).toBe(before);
		expect(h.session.state.plan).toBe(h.plan);
		expect(h.changes).toHaveLength(emitted);
		// Status only: the document is not fetched again.
		expect(h.snapshots).toHaveLength(1);
	});

	it('shares one request between overlapping rechecks', async () => {
		const h = await loaded();
		const first = h.session.recheck();
		const second = h.session.recheck();
		expect(h.statuses).toHaveLength(2);
		h.statuses[1].resolve(status());
		await Promise.all([first, second]);
		void h.session.recheck();
		expect(h.statuses).toHaveLength(3);
	});

	it('revokes the document, plan and review when a recheck fails', async () => {
		const h = await prepared();
		const before = h.session.state;
		const check = h.session.recheck();
		h.statuses[1].reject(unavailable());
		await check;
		expect(h.session.state).toMatchObject({
			availability: 'unavailable',
			document: null,
			plan: null,
			version: null,
			phase: 'idle'
		});
		expect(h.session.state.reviewEpoch).toBeGreaterThan(before.reviewEpoch);
		expect(h.session.state.documentEpoch).toBeGreaterThan(before.documentEpoch);
		expect(await h.session.beginCommit()).toBe(false);
	});

	it('drops a plan signed for an older status version and keeps choices for the same document', async () => {
		const h = await prepared();
		const before = h.session.state;
		const check = h.session.recheck();
		h.statuses[1].resolve(status(2));
		await h.settle();
		expect(h.session.state).toMatchObject({ availability: 'loading', plan: null, phase: 'idle' });
		h.statuses[2].resolve(status(2));
		await h.settle();
		h.snapshots[1].resolve(snapshot(2));
		await check;
		expect(h.session.state).toMatchObject({
			availability: 'available',
			plan: null,
			version: { snapshot: 2, publisher: 0 }
		});
		expect(h.session.state.reviewEpoch).toBeGreaterThan(before.reviewEpoch);
		expect(h.session.state.documentEpoch).toBe(before.documentEpoch);
	});

	it('treats a publisher status change as a version change', async () => {
		const h = await prepared();
		const check = h.session.recheck();
		h.statuses[1].resolve(status(1, 1));
		await h.settle();
		expect(h.session.state).toMatchObject({ availability: 'loading', plan: null });
		h.statuses[2].resolve(status(1, 1));
		await h.settle();
		h.snapshots[1].resolve(snapshot(1));
		await check;
		expect(h.session.state.version).toEqual({ snapshot: 1, publisher: 1 });
	});

	it('resets destination choices when the replacement document differs', async () => {
		const h = await loaded();
		const before = h.session.state.documentEpoch;
		const check = h.session.recheck();
		h.statuses[1].resolve(status(2));
		await h.settle();
		h.statuses[2].resolve(status(2));
		await h.settle();
		h.snapshots[1].resolve(snapshot(2, 'sha256:two'));
		await check;
		expect(h.session.state.document?.digest).toBe('sha256:two');
		expect(h.session.state.documentEpoch).toBe(before + 1);
	});

	it('fails closed when the document and status disagree during acquisition', async () => {
		const h = harness();
		const loading = h.session.load();
		h.statuses[0].resolve(status(1));
		await h.settle();
		h.snapshots[0].resolve(snapshot(2));
		await loading;
		expect(h.session.state).toMatchObject({ availability: 'unavailable', document: null });
	});

	it('accepts a held prepare that completes after an unchanged successful recheck', async () => {
		const h = await loaded();
		const preparing = h.session.prepare(CHOICES);
		void h.session.recheck();
		h.statuses[1].resolve(status());
		await h.settle();
		expect(h.session.state.phase).toBe('preparing');
		const plan = planFor('plan_held');
		h.prepares[0].resolve(plan);
		expect(await preparing).toEqual({ kind: 'prepared', plan });
		expect(h.session.state).toMatchObject({ phase: 'prepared', plan });
	});

	it('discards a held prepare that completes after revocation', async () => {
		const h = await loaded();
		const preparing = h.session.prepare(CHOICES);
		const check = h.session.recheck();
		h.statuses[1].reject(unavailable());
		await check;
		h.prepares[0].resolve(planFor('plan_late'));
		expect(await preparing).toEqual({ kind: 'superseded' });
		expect(h.session.state).toMatchObject({ availability: 'unavailable', plan: null });
	});

	it('discards a held prepare when the destination choices change', async () => {
		const h = await loaded();
		const preparing = h.session.prepare(CHOICES);
		h.session.discardPlan();
		h.prepares[0].resolve(planFor('plan_old_choices'));
		expect(await preparing).toEqual({ kind: 'superseded' });
		expect(h.session.state).toMatchObject({ phase: 'idle', plan: null });
	});

	it('refuses a plan bound to a status version the session does not hold', async () => {
		const h = await loaded();
		const preparing = h.session.prepare(CHOICES);
		h.prepares[0].resolve(planFor('plan_newer', 2));
		await h.settle();
		h.statuses[1].resolve(status(2));
		await h.settle();
		h.snapshots[1].resolve(snapshot(2));
		expect(await preparing).toEqual({ kind: 'superseded' });
		expect(h.session.state).toMatchObject({
			availability: 'available',
			plan: null,
			version: { snapshot: 2, publisher: 0 }
		});
	});

	it('revokes when prepare reports the publication unavailable, and a held recheck cannot restore it', async () => {
		const h = await loaded();
		const check = h.session.recheck();
		const preparing = h.session.prepare(CHOICES);
		h.prepares[0].reject(unavailable());
		expect(await preparing).toEqual({ kind: 'superseded' });
		expect(h.session.state.availability).toBe('unavailable');
		h.statuses[1].resolve(status());
		await check;
		expect(h.session.state).toMatchObject({ availability: 'unavailable', document: null });
	});

	it('returns other prepare failures to the caller and keeps the document', async () => {
		const h = await loaded();
		const preparing = h.session.prepare(CHOICES);
		const error = new ApiError(
			422,
			{ code: 'missing_input', message: 'Choose a workflow' },
			'Choose a workflow'
		);
		h.prepares[0].reject(error);
		expect(await preparing).toEqual({ kind: 'failed', error });
		expect(h.session.state).toMatchObject({ availability: 'available', phase: 'idle' });
		expect(h.session.state.document?.digest).toBe('sha256:one');
	});

	it('retries acquisition quietly while unavailable and announces only a recovery', async () => {
		const h = await loaded();
		const failing = h.session.recheck();
		h.statuses[1].reject(unavailable());
		await failing;
		const emitted = h.changes.length;
		const stillGone = h.session.recheck();
		h.statuses[2].reject(unavailable());
		await stillGone;
		expect(h.changes).toHaveLength(emitted);
		const back = h.session.recheck();
		h.statuses[3].resolve(status(3));
		await h.settle();
		h.snapshots[1].resolve(snapshot(3));
		await back;
		expect(h.session.state).toMatchObject({
			availability: 'available',
			version: { snapshot: 3, publisher: 0 },
			plan: null
		});
	});

	it('confirms availability before a commit and refuses when the snapshot is gone', async () => {
		const h = await prepared();
		const committing = h.session.beginCommit();
		h.statuses[1].reject(unavailable());
		expect(await committing).toBe(false);
		expect(h.session.state).toMatchObject({ availability: 'unavailable', plan: null });
	});

	it('suspends reads once a commit begins, so a held recheck cannot revoke an uncertain install', async () => {
		const h = await prepared();
		const heldCheck = h.session.recheck();
		const committing = h.session.beginCommit();
		h.statuses[2].resolve(status());
		expect(await committing).toBe(true);
		expect(h.session.state).toMatchObject({ phase: 'committing', plan: h.plan });
		h.statuses[1].reject(unavailable());
		await heldCheck;
		expect(h.session.state).toMatchObject({
			availability: 'available',
			phase: 'committing',
			plan: h.plan
		});
		const requests = h.statuses.length;
		await h.session.recheck();
		await h.session.load();
		expect(h.statuses).toHaveLength(requests);
		expect(h.session.state.phase).toBe('committing');
	});

	it('resumes reads after a rejected commit, with or without the plan', async () => {
		const h = await prepared();
		const committing = h.session.beginCommit();
		h.statuses[1].resolve(status());
		expect(await committing).toBe(true);
		h.session.commitRejected(true);
		expect(h.session.state).toMatchObject({ phase: 'prepared', plan: h.plan });
		const check = h.session.recheck();
		expect(h.statuses).toHaveLength(3);
		h.statuses[2].resolve(status());
		await check;

		const again = h.session.beginCommit();
		h.statuses[3].resolve(status());
		expect(await again).toBe(true);
		h.session.commitRejected(false);
		expect(h.session.state).toMatchObject({ phase: 'idle', plan: null });
	});

	it('does not commit a plan that was discarded while availability was being confirmed', async () => {
		const h = await prepared();
		const committing = h.session.beginCommit();
		h.session.discardPlan();
		h.statuses[1].resolve(status());
		expect(await committing).toBe(false);
		expect(h.session.state).toMatchObject({ phase: 'idle', plan: null });
	});

	it('reports nothing after disposal', async () => {
		const h = await loaded();
		const check = h.session.recheck();
		h.session.dispose();
		const emitted = h.changes.length;
		h.statuses[1].reject(unavailable());
		await check;
		expect(h.changes).toHaveLength(emitted);
	});
});
