import { error, redirect } from '@sveltejs/kit';
import { ApiFail } from '$lib/server/api/core';
import { truncate } from '$lib/format';
import { effectiveContextForIssue, listContextItems } from '$lib/server/api/context';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getIssueDetail, loadIssue } from '$lib/server/api/issues';
import {
	memberScopeAllowed,
	redactForMember,
	scopeIssueLinksForMember
} from '$lib/server/api/member-context';
import { SHARED_EVENT_TYPES, sharedEventPayload } from '$lib/server/api/shared-events';
import {
	actorForProject,
	resolveAccessibleProjectRef,
	resolveIssueAccess,
	resolveProjectAccess
} from '$lib/server/api/project-access';
import { listIssuePermissionRoster, readIssueConsent } from '$lib/server/api/personal-consent';
import { listLabelsInternal } from '$lib/server/api/labels';
import { listRunners } from '$lib/server/api/runners';
import { listRoutingRules } from '$lib/server/api/routing';
import { hasAnyRun, listRuns } from '$lib/server/api/runs';
import { getIssueUsage } from '$lib/server/api/usage';
import { mintUsageScope, usageKeyMaterial } from '$lib/server/usage-scope';
import { loadWorkflows } from '$lib/server/api/workflows';
import { explainDispatch } from '$lib/server/supervisor/explain';
import { getDb } from '$lib/server/db';
import { sessionActor } from '$lib/server/api/core';
import type { PageServerLoad } from './$types';

/**
 * Two D1 waves, not seven (Tines/32). Everything except the issue row itself
 * keys off `issue.id`, so the row is resolved alone and then the whole rest of
 * the page fans out at once. Nothing here may be fetched twice: workflows are
 * loaded once and handed to `getIssueDetail`, artifacts once (it returns them),
 * and the issue row once (`explainDispatch` takes it rather than re-reading).
 *
 * Only the first wave is awaited. The panels below the fold stream in as
 * promises, so the View Transition in `(app)/+layout.svelte` — which waits on
 * `navigation.complete` — commits as soon as the header and comments can
 * paint. Keep the awaited set small: anything moved out of `deferred` puts
 * itself back on the navigation critical path.
 */
export const load: PageServerLoad = async ({
	locals,
	platform,
	params,
	depends,
	parent,
	url,
	isDataRequest
}) => {
	const db = getDb(platform!.env);
	const viewerId = locals.user!.id;
	const actor = sessionActor(locals.user!);

	// Mutations and the live poll refresh this page alone (see +page.svelte);
	// invalidateAll() would also re-run the layout for no reason.
	depends('app:issue');

	// Issue numbers are 1-based; "abc" and "-1" are addresses, not issues.
	const number = Number.parseInt(params.number, 10);
	if (!Number.isInteger(number) || number < 1)
		error(404, `“${truncate(params.number)}” is not an issue number.`);
	const directProject = await db
		.selectFrom('project')
		.select('id')
		.where('id', '=', params.project)
		.executeTakeFirst();
	const addressProjectId = directProject
		? directProject.id
		: await resolveAccessibleProjectRef(db, actor, params.project).catch((e) => {
				if (e instanceof ApiFail && e.status === 404)
					error(404, `You have no project named “${truncate(params.project)}”.`);
				if (e instanceof ApiFail) error(e.status, e.message);
				throw e;
			});
	const addressed = await db
		.selectFrom('issue_address')
		.select('issue_id')
		.where('project_id', '=', addressProjectId)
		.where('number', '=', number)
		.executeTakeFirst();
	if (!addressed) {
		await resolveProjectAccess(db, actor, addressProjectId).catch((e) => {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		});
		const named = await db
			.selectFrom('project')
			.select('name')
			.where('id', '=', addressProjectId)
			.executeTakeFirstOrThrow();
		error(404, `Issue #${number} does not exist in “${truncate(named.name)}”.`);
	}
	const access = await resolveIssueAccess(db, actor, addressed.issue_id).catch((e) => {
		if (e instanceof ApiFail) error(e.status, e.message);
		throw e;
	});
	if (access.projectId !== addressProjectId)
		await resolveProjectAccess(db, actor, addressProjectId).catch((e) => {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		});
	// A member sees the owner's page for a shared issue, loaded with the
	// owner's scope. What stays the owner's (runners, routing, run logs, the
	// launch prompt, account-wide context and spend) is left out below.
	const isMember = access.role === 'member';
	const scopeActor = isMember ? await actorForProject(db, actor, access.projectId) : actor;
	const userId = scopeActor.userId;

	// Wave 1: the issue row (URLs address projects by name, joined here so the
	// project resolve is not a round trip of its own) alongside the two lists
	// that do not depend on it.
	const workflowsPromise = loadWorkflows(db, userId);
	// A rejected promise that nothing awaits until wave 2 would be an unhandled
	// rejection if the issue lookup throws first.
	workflowsPromise.catch(() => {});

	const issue = await loadIssue(db, userId, { id: addressed.issue_id }).catch(async () => {
		// Only the 404 path pays for naming which half of the address was
		// wrong, and only it awaits the layout: both halves, so an archived
		// project says "no such issue" rather than "no such project".
		const { projects, archivedProjects } = await parent();
		error(
			404,
			[...projects, ...archivedProjects].some((p) => p.name === params.project)
				? `Issue #${number} does not exist in “${truncate(params.project)}”.`
				: `You have no project named “${truncate(params.project)}”.`
		);
	});
	const sharing = await db
		.selectFrom('project')
		.select('shared_at')
		.where('id', '=', issue.project_id)
		.where('user_id', '=', userId)
		.executeTakeFirst();
	const permissionReceipt =
		sharing?.shared_at == null ? null : await readIssueConsent(db, viewerId, issue.id);
	const permissionRoster =
		sharing?.shared_at == null ? [] : await listIssuePermissionRoster(db, issue.id);
	const canonicalPath = `/issues/${encodeURIComponent(issue.project_id)}/${issue.number}`;
	if (!isDataRequest && url.pathname !== canonicalPath) {
		// A native document redirect retains the browser fragment. Client data
		// navigations are canonicalized in +page.svelte where the hash is visible.
		redirect(307, `${canonicalPath}${url.search}`);
	}

	// Wave 2: everything else, in parallel.
	const detailPromise = getIssueDetail(db, userId, issue, {
		workflows: workflowsPromise,
		artifacts: true
	});
	const eventsPromise = eventQuery(db, userId)
		.where('event.issue_id', '=', issue.id)
		.orderBy('event.created_at desc')
		.orderBy('event.id desc')
		.limit(100)
		.execute()
		.then((rows) => rows.map(serializeEvent));

	const [detail, events, labelLibrary] = await Promise.all([
		detailPromise,
		eventsPromise,
		// The whole vocabulary, for the labels picker in the aside.
		listLabelsInternal(db, userId)
	]);

	// The artifacts ride along on the detail (fetched in the same wave); expose
	// them under exactly one name so nothing can read a stale second copy.
	const { artifacts, ...ownerDetail } = detail;
	const issueDetail = await scopeIssueLinksForMember(db, scopeActor, ownerDetail);
	// A member's history is the shared allowlist: payloads that could name the
	// owner's other projects or private fields stay out.
	const visibleEvents = isMember
		? events
				.filter((event) => SHARED_EVENT_TYPES.includes(event.type))
				.map((event) => ({
					...event,
					payload: sharedEventPayload(event.type, JSON.stringify(event.payload))
				}))
		: events;

	// Awaited by two deferred entries; created once so the check is not made twice.
	const hasAnyRunPromise = hasAnyRun(db, userId);
	hasAnyRunPromise.catch(() => {});
	const usagePromise = (async () => {
		// Spend is the owner's account, not the project's.
		if (isMember) return null;
		const cutoff = Date.now();
		const report = await getIssueUsage(db, userId, issue.id, cutoff, cutoff);
		if (!report) throw new Error('Issue usage unavailable');
		const material = usageKeyMaterial(platform!.env);
		if (!material) throw new Error('Usage evidence signing is not configured');
		report.scope = await mintUsageScope(
			{
				v: 1,
				owner: userId,
				mode: 'issue',
				issue: issue.id,
				cutoff,
				timezone: report.timezone,
				timezone_source: report.timezone_source
			},
			material
		);
		return report;
	})();
	usagePromise.catch(() => {});

	const ownerOnly = <T>(value: T) => Promise.resolve(value);
	return {
		mode: 'owner' as const,
		viewerRole: access.role,
		viewerId,
		issue: issueDetail,
		permissionReceipt,
		permissionRoster,
		canonicalPath,
		events: visibleEvents,
		workflows: await workflowsPromise,
		// `projects` comes from the app layout.
		artifacts: artifacts ?? [],
		labelLibrary,
		// Streamed: the sidebar panels. Each renders a skeleton until its first
		// value lands; on refreshes the page keeps the previous value on screen
		// while the replacement promise is in flight (streamed() in +page.svelte).
		deferred: {
			// Items whose scope includes this issue (all issue-anchored shapes).
			// Artifacts have their own panel; the context list shows the rest.
			contextItems: listContextItems(
				db,
				scopeActor,
				{ issue: issue.id },
				{ cursor: null, limit: 100 }
			).then(async (page) => {
				const items = page.items.filter((i) => i.kind !== 'artifact');
				if (!isMember) return items;
				const allowed = await Promise.all(
					items.map((item) => memberScopeAllowed(db, scopeActor, item.scope))
				);
				return items
					.filter((_, index) => allowed[index])
					.map((item) => redactForMember(scopeActor, item));
			}),
			// Display-only bundle: the panel shows skill file counts, never their
			// contents, which can run to 100KB per skill on every page load.
			effectiveContext: isMember
				? ownerOnly(null)
				: effectiveContextForIssue(db, userId, issue.id, { skillFiles: false }),
			// Routing and runner verdicts describe the owner's machines.
			dispatch: isMember
				? ownerOnly(null)
				: explainDispatch(db, userId, issue.id, Date.now(), issue),
			issueRuns: listRuns(db, userId, { issue: issue.id }, { cursor: null, limit: 20 }).then(
				(page) => page.items
			),
			usage: usagePromise,
			runners: isMember ? ownerOnly([]) : listRunners(db, userId),
			// The first-run checklist: shown only while the account has never had
			// a run, so the rules it needs are fetched only for that population —
			// a steady-state page pays one existence check and nothing else.
			hasAnyRun: isMember ? ownerOnly(true) : hasAnyRunPromise,
			rules: isMember
				? ownerOnly([])
				: hasAnyRunPromise.then((has) => (has ? [] : listRoutingRules(db, userId)))
		}
	};
};
