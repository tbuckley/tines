import {
	ApiError,
	type PrepareWorkflowPackageResponse,
	type PublicSnapshotStatus,
	type PublicWorkflowSnapshot,
	type WorkflowPackageChoices,
	type WorkflowPackageDocument
} from '@tines/shared';

/** The three requests a hosted install session makes, injected so interleavings can be tested. */
export interface HostedInstallTransport {
	getStatus(snapshotId: string): Promise<PublicSnapshotStatus>;
	getSnapshot(snapshotId: string): Promise<PublicWorkflowSnapshot>;
	prepare(
		snapshotId: string,
		choices: WorkflowPackageChoices
	): Promise<PrepareWorkflowPackageResponse>;
}

export interface HostedStatusVersion {
	snapshot: number;
	publisher: number;
}

export type HostedAvailability = 'loading' | 'available' | 'unavailable';
/** `committing` covers the install request and everything after it: unknown outcome and receipt. */
export type HostedInstallPhase = 'idle' | 'preparing' | 'prepared' | 'committing';

export interface HostedInstallState {
	readonly snapshotId: string;
	readonly availability: HostedAvailability;
	readonly version: HostedStatusVersion | null;
	readonly document: WorkflowPackageDocument | null;
	readonly plan: PrepareWorkflowPackageResponse | null;
	readonly phase: HostedInstallPhase;
	/** Changes when the dependency review and confirmation no longer describe what would install. */
	readonly reviewEpoch: number;
	/** Changes when destination choices no longer apply: a different document, or a revocation. */
	readonly documentEpoch: number;
}

export type HostedPrepareResult =
	| { kind: 'prepared'; plan: PrepareWorkflowPackageResponse }
	| { kind: 'failed'; error: unknown }
	/** The session moved on while the request was held; its state already says where to. */
	| { kind: 'superseded' };

export interface HostedInstallSession {
	readonly state: HostedInstallState;
	/** Initial document acquisition. */
	load(): Promise<void>;
	/** Status-only revalidation. An unchanged successful check changes nothing. */
	recheck(): Promise<void>;
	prepare(choices: WorkflowPackageChoices): Promise<HostedPrepareResult>;
	/** The destination choices changed, so the prepared plan no longer matches them. */
	discardPlan(): void;
	/** Confirms availability one last time, then suspends reads. False means do not install. */
	beginCommit(): Promise<boolean>;
	/** The server rejected the install before creating anything, so reads resume. */
	commitRejected(keepPlan: boolean): void;
	dispose(): void;
}

/**
 * Owns one hosted snapshot's install lifetime on the import page: which status version the
 * document and plan belong to, whether the snapshot is still available, and which responses are
 * still allowed to change that. The page keeps presentation and the install request itself.
 */
export function createHostedInstallSession(
	snapshotId: string,
	transport: HostedInstallTransport,
	onChange: (state: HostedInstallState) => void
): HostedInstallSession {
	let state: HostedInstallState = {
		snapshotId,
		availability: 'loading',
		version: null,
		document: null,
		plan: null,
		phase: 'idle',
		reviewEpoch: 0,
		documentEpoch: 0
	};
	// A read response is accepted only while the generation that sent it is current.
	let readGeneration = 0;
	let prepareGeneration = 0;
	let checking: Promise<void> | null = null;
	let lastDigest: string | null = null;
	let disposed = false;

	function set(patch: Partial<HostedInstallState>) {
		state = { ...state, ...patch };
		if (!disposed) onChange(state);
	}

	function sameVersion(status: PublicSnapshotStatus) {
		return (
			state.version?.snapshot === status.status_version &&
			state.version.publisher === status.publisher_status_version
		);
	}

	function revoke() {
		readGeneration++;
		prepareGeneration++;
		lastDigest = null;
		set({
			availability: 'unavailable',
			version: null,
			document: null,
			plan: null,
			phase: 'idle',
			reviewEpoch: state.reviewEpoch + 1,
			documentEpoch: state.documentEpoch + 1
		});
	}

	/** `quiet` retries from unavailable without announcing anything unless the snapshot is back. */
	async function acquire(quiet: boolean) {
		const generation = ++readGeneration;
		prepareGeneration++;
		if (!quiet)
			set({
				availability: 'loading',
				plan: null,
				phase: 'idle',
				reviewEpoch: state.reviewEpoch + 1
			});
		try {
			const status = await transport.getStatus(snapshotId);
			if (generation !== readGeneration) return;
			const snapshot = await transport.getSnapshot(snapshotId);
			if (generation !== readGeneration) return;
			// A document read across a status change belongs to neither version.
			if (snapshot.status_version !== status.status_version)
				throw new Error('Snapshot status changed during acquisition');
			const sameDocument = snapshot.document.digest === lastDigest;
			lastDigest = snapshot.document.digest;
			set({
				availability: 'available',
				version: {
					snapshot: status.status_version,
					publisher: status.publisher_status_version
				},
				document: snapshot.document,
				plan: null,
				phase: 'idle',
				documentEpoch: sameDocument ? state.documentEpoch : state.documentEpoch + 1
			});
		} catch {
			if (generation !== readGeneration) return;
			if (state.availability !== 'unavailable') revoke();
		}
	}

	/** True only when the snapshot is available at the version this session already holds. */
	async function verify(): Promise<boolean> {
		const generation = readGeneration;
		let status: PublicSnapshotStatus;
		try {
			status = await transport.getStatus(snapshotId);
		} catch {
			if (generation === readGeneration) revoke();
			return false;
		}
		if (generation !== readGeneration) return false;
		if (sameVersion(status)) return true;
		// Still published, but a plan signed for the old version must not be reused.
		await acquire(false);
		return false;
	}

	return {
		get state() {
			return state;
		},
		async load() {
			if (disposed || state.phase === 'committing') return;
			await acquire(false);
		},
		recheck() {
			if (disposed || state.phase === 'committing' || state.availability === 'loading')
				return Promise.resolve();
			if (checking) return checking;
			const read = state.availability === 'unavailable' ? acquire(true) : verify();
			const tracked: Promise<void> = read.then(
				() => undefined,
				() => undefined
			);
			checking = tracked;
			void tracked.then(() => {
				if (checking === tracked) checking = null;
			});
			return tracked;
		},
		async prepare(choices) {
			if (disposed || state.availability !== 'available' || state.phase !== 'idle')
				return { kind: 'superseded' };
			const generation = ++prepareGeneration;
			set({ phase: 'preparing', plan: null });
			try {
				const plan = await transport.prepare(snapshotId, choices);
				if (generation !== prepareGeneration) return { kind: 'superseded' };
				if (
					plan.source &&
					(plan.source.snapshot_status_version !== state.version?.snapshot ||
						plan.source.publisher_status_version !== state.version.publisher)
				) {
					await acquire(false);
					return { kind: 'superseded' };
				}
				set({ phase: 'prepared', plan });
				return { kind: 'prepared', plan };
			} catch (error) {
				if (generation !== prepareGeneration) return { kind: 'superseded' };
				if (error instanceof ApiError && error.code === 'publication_unavailable') {
					revoke();
					return { kind: 'superseded' };
				}
				set({ phase: 'idle' });
				return { kind: 'failed', error };
			}
		},
		discardPlan() {
			if (state.availability !== 'available') return;
			if (state.phase !== 'preparing' && state.phase !== 'prepared') return;
			prepareGeneration++;
			set({ phase: 'idle', plan: null });
		},
		async beginCommit() {
			const plan = state.plan;
			if (disposed || !plan || state.phase !== 'prepared' || state.availability !== 'available')
				return false;
			// A check sent before this decision must not answer for it.
			readGeneration++;
			if (!(await verify())) return false;
			if (state.plan !== plan || state.phase !== 'prepared') return false;
			// From here the install result owns the page: discard any read still in flight.
			readGeneration++;
			set({ phase: 'committing' });
			return true;
		},
		commitRejected(keepPlan) {
			if (state.phase !== 'committing') return;
			set(keepPlan ? { phase: 'prepared' } : { phase: 'idle', plan: null });
		},
		dispose() {
			disposed = true;
			readGeneration++;
			prepareGeneration++;
		}
	};
}
