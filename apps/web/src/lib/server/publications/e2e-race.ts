/**
 * Built-worker transaction race hook. Vite replaces the flag at build time, so
 * production builds cannot activate these mutations even if a caller supplies
 * the private test header.
 */
let quotaBarrier: Array<{
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}> = [];

function waitForQuotaPair(): Promise<void> {
	return new Promise((resolve, reject) => {
		const waiter = {
			resolve,
			reject,
			timer: setTimeout(() => {
				quotaBarrier = quotaBarrier.filter((item) => item !== waiter);
				reject(new Error('Publication quota race barrier timed out'));
			}, 5_000)
		};
		quotaBarrier.push(waiter);
		if (quotaBarrier.length < 2) return;
		const pair = quotaBarrier.splice(0, 2);
		for (const item of pair) {
			clearTimeout(item.timer);
			item.resolve();
		}
	});
}

export async function runE2ePublicationRaceMutation(
	request: Request,
	env: Env,
	target: { snapshotId?: string; publicationId?: string }
): Promise<void> {
	if (import.meta.env.VITE_TINES_E2E !== '1') return;
	const action = request.headers.get('x-tines-e2e-publication-race');
	if (!action) return;
	if (action === 'quota-barrier') return waitForQuotaPair();
	let statement: ReturnType<Env['DB']['prepare']>;
	if (action === 'disable' && target.snapshotId) {
		statement = env.DB.prepare(
			"UPDATE workflow_publication SET host_state = 'removed', status_version = status_version + 1 WHERE snapshot_id = ? AND host_state = 'active'"
		).bind(target.snapshotId);
	} else if (action === 'restore' && target.snapshotId) {
		statement = env.DB.prepare(
			"UPDATE workflow_publication SET host_state = 'active', status_version = status_version + 1 WHERE snapshot_id = ? AND host_state = 'removed'"
		).bind(target.snapshotId);
	} else if (
		(action === 'suspend' || action === 'unsuspend') &&
		(target.snapshotId || target.publicationId)
	) {
		const suspended = action === 'suspend' ? 1 : 0;
		statement = env.DB.prepare(
			`INSERT INTO workflow_publisher_status (user_id, suspended, status_version)
			 SELECT user_id, ?, 1 FROM workflow_publication
			 WHERE ${target.snapshotId ? 'snapshot_id' : 'id'} = ?
			 ON CONFLICT(user_id) DO UPDATE SET suspended = excluded.suspended,
			 status_version = workflow_publisher_status.status_version + 1`
		).bind(suspended, target.snapshotId ?? target.publicationId);
	} else {
		throw new Error(`Unsupported publication race mutation: ${action}`);
	}
	const result = await statement.run();
	if (result.meta.changes !== 1)
		throw new Error(`Publication race mutation did not change one row: ${action}`);
}
