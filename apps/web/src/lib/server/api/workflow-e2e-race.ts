/** Compiled out of production builds; coordinates native-D1 workflow save races. */

const HEADER = 'x-tines-e2e-workflow-race';

type Barrier = {
	entered: Promise<void>;
	release: Promise<void>;
	markEntered: () => void;
	markReleased: () => void;
};
const barriers = new Map<string, Barrier>();

function barrier(workflowId: string): Barrier {
	let current = barriers.get(workflowId);
	if (current) return current;
	let markEntered!: () => void;
	let markReleased!: () => void;
	current = {
		entered: new Promise<void>((resolve) => {
			markEntered = resolve;
		}),
		release: new Promise<void>((resolve) => {
			markReleased = resolve;
		}),
		markEntered: () => markEntered(),
		markReleased: () => markReleased()
	};
	barriers.set(workflowId, current);
	return current;
}

async function bounded(wait: Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			wait,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Native workflow race barrier timed out')),
					10_000
				);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function action(request: Request): string | null {
	if (import.meta.env.VITE_TINES_E2E !== '1') return null;
	return request.headers.get(HEADER);
}

/**
 * The stale save's `beforeCommit`: its preflight reads are done and its batch
 * is compiled, and it holds there until the competing save has committed.
 */
export function e2eWorkflowSaveHold(
	request: Request,
	workflowId: string
): (() => Promise<void>) | undefined {
	const requested = action(request);
	if (!requested || requested === 'release-held-save') return;
	if (requested !== 'wait-for-competing-save') {
		throw new Error(`Unsupported native workflow race: ${requested}`);
	}
	return async () => {
		const current = barrier(workflowId);
		current.markEntered();
		try {
			await bounded(current.release);
		} finally {
			barriers.delete(workflowId);
		}
	};
}

/** The competing save waits until the stale one is holding before its batch. */
export async function waitForE2eHeldWorkflowSave(request: Request, workflowId: string) {
	if (action(request) !== 'release-held-save') return;
	await bounded(barrier(workflowId).entered);
}

export function releaseE2eHeldWorkflowSave(request: Request, workflowId: string) {
	if (action(request) !== 'release-held-save') return;
	barrier(workflowId).markReleased();
	barriers.delete(workflowId);
}
