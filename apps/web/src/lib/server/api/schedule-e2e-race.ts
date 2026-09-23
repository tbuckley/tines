/** Compiled out of production builds; coordinates native-D1 pre-batch races. */
import type { Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import type { ActorContext } from './core';
import { deleteSchedule, updateSchedule } from './schedules';

type Barrier = {
	entered: Promise<void>;
	release: Promise<void>;
	markEntered: () => void;
	markReleased: () => void;
};
const barriers = new Map<string, Barrier>();

function barrier(scheduleId: string): Barrier {
	let current = barriers.get(scheduleId);
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
	barriers.set(scheduleId, current);
	return current;
}

async function bounded(wait: Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			wait,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error('Native schedule race barrier timed out')),
					10_000
				);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The browser off request waits until Run now has compiled its guarded batch. */
export async function waitForE2eSchedulePreparation(request: Request, scheduleId: string) {
	if (
		import.meta.env.VITE_TINES_E2E !== '1' ||
		request.headers.get('x-tines-e2e-schedule-race') !== 'release-run-now'
	)
		return;
	await bounded(barrier(scheduleId).entered);
}

export function releaseE2eSchedulePreparation(request: Request, scheduleId: string) {
	if (
		import.meta.env.VITE_TINES_E2E !== '1' ||
		request.headers.get('x-tines-e2e-schedule-race') !== 'release-run-now'
	)
		return;
	barrier(scheduleId).markReleased();
	barriers.delete(scheduleId);
}

export async function runE2eScheduleRaceMutation(
	request: Request,
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	scheduleId: string
): Promise<void> {
	if (import.meta.env.VITE_TINES_E2E !== '1') return;
	const action = request.headers.get('x-tines-e2e-schedule-race');
	if (!action) return;
	if (action === 'wait-for-off') {
		const current = barrier(scheduleId);
		current.markEntered();
		try {
			await bounded(current.release);
		} finally {
			barriers.delete(scheduleId);
		}
	} else if (action === 'delete') {
		await deleteSchedule(db, env, actor, scheduleId);
	} else if (action === 'meaningful-change') {
		const current = await db
			.selectFrom('scheduled_task')
			.select('description_template')
			.where('id', '=', scheduleId)
			.executeTakeFirstOrThrow();
		await updateSchedule(db, env, actor, scheduleId, {
			description_template: `${current.description_template} changed`
		});
	} else {
		throw new Error(`Unsupported native schedule race: ${action}`);
	}
}
