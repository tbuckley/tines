import type { UpdatePreferencesRequest, UserPreferences } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { ApiFail, requireString, runAtomic, type ActorContext } from './core';
import { accessAllowed, requireAccess } from './permissions';

/**
 * Per-user UI preferences: the project focus (Tines/259). The row is created
 * lazily on first write, so "no row" is the same thing as "All projects".
 * Deliberately event-free: focus moves on every project-page open and would
 * drown the activity feed.
 */

const NO_PREFERENCES: UserPreferences = {
	focused_project_id: null,
	last_project_id: null,
	updated_at: null
};

export async function getPreferences(
	db: Kysely<Database>,
	userId: string
): Promise<UserPreferences> {
	const row = await db
		.selectFrom('user_preference')
		.selectAll()
		.where('user_id', '=', userId)
		.executeTakeFirst();
	if (!row) return NO_PREFERENCES;
	return {
		focused_project_id: row.focused_project_id,
		last_project_id: row.last_project_id,
		updated_at: row.updated_at
	};
}

export async function getPreferencesForActor(
	db: Kysely<Database>,
	actor: ActorContext
): Promise<UserPreferences> {
	requireAccess(actor, [{ domain: 'workspace', access: 'read' }], 'preference.read');
	const preferences = await getPreferences(db, actor.userId);
	const visible = (id: string | null) =>
		id !== null &&
		accessAllowed(actor, [{ domain: 'project', access: 'read', projectId: id }], 'project.read', {
			projectId: id
		});
	return {
		...preferences,
		focused_project_id: visible(preferences.focused_project_id)
			? preferences.focused_project_id
			: null,
		last_project_id: visible(preferences.last_project_id) ? preferences.last_project_id : null
	};
}

/**
 * Both pointers must name one of the actor's *live* projects: a focus is by
 * definition live, and `last_project_id` keeps the same rule so New issue
 * never has to explain a dead default.
 */
async function requireLiveProject(
	db: Kysely<Database>,
	actor: ActorContext,
	value: unknown,
	field: string
): Promise<string> {
	const id = requireString(value, field, { max: 100 });
	requireAccess(actor, [{ domain: 'project', access: 'read', projectId: id }], 'project.read', {
		projectId: id
	});
	const row = await db
		.selectFrom('project')
		.select('id')
		.where('id', '=', id)
		.where(
			field === 'focused_project_id'
				? sql<boolean>`(user_id = ${actor.userId} OR (shared_at IS NOT NULL AND EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = project.id AND m.user_id = ${actor.userId} AND m.revoked_at IS NULL)))`
				: sql<boolean>`user_id = ${actor.userId}`
		)
		.where('archived_at', 'is', null)
		.executeTakeFirst();
	if (!row) {
		throw new ApiFail(422, 'invalid_field', `"${field}" must name one of your live projects`, {
			field
		});
	}
	return id;
}

export async function updatePreferences(
	db: Kysely<Database>,
	env: App.Platform['env'],
	actor: ActorContext,
	body: UpdatePreferencesRequest
): Promise<UserPreferences> {
	const current = await getPreferences(db, actor.userId);

	let focused = current.focused_project_id;
	if ('focused_project_id' in body) {
		focused =
			body.focused_project_id === null
				? null
				: await requireLiveProject(db, actor, body.focused_project_id, 'focused_project_id');
	}

	let last = current.last_project_id;
	if ('last_project_id' in body) {
		last =
			body.last_project_id === null
				? null
				: await requireLiveProject(db, actor, body.last_project_id, 'last_project_id');
	} else if (
		focused !== null &&
		focused !== current.focused_project_id &&
		(await db
			.selectFrom('project')
			.select('id')
			.where('id', '=', focused)
			.where('user_id', '=', actor.userId)
			.executeTakeFirst())
	) {
		// Focusing a project also makes it the New-issue fallback, which is what
		// keeps "last focused" alive after a switch back to All projects.
		last = focused;
	}

	const now = Date.now();
	await runAtomic(env, [
		db
			.insertInto('user_preference')
			.values({
				user_id: actor.userId,
				focused_project_id: focused,
				last_project_id: last,
				updated_at: now
			})
			.onConflict((oc) =>
				oc.column('user_id').doUpdateSet({
					focused_project_id: focused,
					last_project_id: last,
					updated_at: now
				})
			)
			.compile()
	]);

	return { focused_project_id: focused, last_project_id: last, updated_at: now };
}

/**
 * Sets the focus (and the New-issue fallback with it) for a page load, which
 * has a user id rather than a request actor — the `?project=` one-shot.
 */
export async function setFocus(
	db: Kysely<Database>,
	env: App.Platform['env'],
	userId: string,
	projectId: string
): Promise<UserPreferences> {
	return updatePreferences(db, env, actorFor(userId), { focused_project_id: projectId });
}

/** A page load's actor: preferences are never written on anyone else's behalf. */
function actorFor(userId: string): ActorContext {
	return { userId, userName: '', apiKeyId: null, apiKeyName: null, viaSession: true };
}

export interface ResolvedFocus {
	/** The focused project's id, only when it still exists and is live. */
	focusId: string | null;
	/** The New-issue fallback, raw (the caller checks it against its project list). */
	lastProjectId: string | null;
	/** The stored pointer when it did *not* resolve — the layout clears it lazily. */
	staleFocusId: string | null;
}

/**
 * One query: the preferences row LEFT JOINed to its focused project, so a
 * missing or archived project reads as "All projects" without a second wave.
 */
export async function resolveFocus(db: Kysely<Database>, userId: string): Promise<ResolvedFocus> {
	const row = await db
		.selectFrom('user_preference')
		.leftJoin('project', (join) =>
			join
				.onRef('project.id', '=', 'user_preference.focused_project_id')
				.on(
					sql<boolean>`(project.user_id = ${userId} OR (project.shared_at IS NOT NULL AND EXISTS (SELECT 1 FROM project_member m WHERE m.project_id = project.id AND m.user_id = ${userId} AND m.revoked_at IS NULL)))`
				)
				.on('project.archived_at', 'is', null)
		)
		.select([
			'user_preference.focused_project_id as pointer',
			'user_preference.last_project_id as last_project_id',
			'project.id as live_id'
		])
		.where('user_preference.user_id', '=', userId)
		.executeTakeFirst();
	if (!row) return { focusId: null, lastProjectId: null, staleFocusId: null };
	return {
		focusId: row.live_id ?? null,
		lastProjectId: row.last_project_id,
		staleFocusId: row.live_id === null ? row.pointer : null
	};
}

/**
 * Clears a focus whose project is gone or archived. Conditional on the stale
 * id so a PATCH racing the page load is never undone, and one-way on purpose:
 * unarchiving a project does not restore it as the focus.
 */
export async function clearStaleFocus(
	db: Kysely<Database>,
	env: App.Platform['env'],
	userId: string,
	staleId: string
): Promise<void> {
	await runAtomic(env, [
		db
			.updateTable('user_preference')
			.set({ focused_project_id: null, updated_at: Date.now() })
			.where('user_id', '=', userId)
			.where('focused_project_id', '=', staleId)
			.compile()
	]);
}
