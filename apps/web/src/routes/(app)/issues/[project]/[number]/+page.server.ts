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
import { sharedExecutionEnabled } from '$lib/server/api/shared-execution';
import {
	bundleFailureText,
	loadSharedExecutionBundle
} from '$lib/server/api/shared-execution-bundle';
import type { EffectiveContext } from '@tines/shared';
import {
	actorForProject,
	memberActor,
	projectAccessFromRow,
	resolveAccessibleProjectRef,
	resolveIssueAccess
} from '$lib/server/api/project-access';
import { listIssuePermissionRoster, readIssueConsent } from '$lib/server/api/personal-consent';
import { listLabelsInternal } from '$lib/server/api/labels';
import { listRunners } from '$lib/server/api/runners';
import { listRoutingRules } from '$lib/server/api/routing';
import { hasAnyRun, listRuns } from '$lib/server/api/runs';
import { getIssueUsage } from '$lib/server/api/usage';
import { loadWorkflows } from '$lib/server/api/workflows';
import { explainDispatch } from '$lib/server/supervisor/explain';
import { getDb } from '$lib/server/db';
import { sessionActor } from '$lib/server/api/core';
import type { PageServerLoad } from './$types';

/**
 * The guidance panel's value: the effective context, whether it is a shared
 * project's projection (Tines/752), and why it could not be assembled.
 */
export interface IssueGuidancePanel {
	context: EffectiveContext | null;
	shared: boolean;
	failure: string | null;
}

/**
 * Two D1 waves to first paint (Tines/32; regained after sharing added a
 * serial access chain in front of them): (A) one statement resolves the
 * address, the project, the viewer's membership and the issue's id, project,
 * workflow and state, so access is decided without a round trip of its own;
 * (B) the issue row and everything keyed by those columns — the detail's
 * comments, links, context summary and artifacts included — fan out at once.
 * Nothing here may be fetched twice: workflows are loaded once and handed to
 * `getIssueDetail`, artifacts once (it returns them), and the issue row once
 * (`explainDispatch` takes it rather than re-reading). `perf:nav` holds the
 * page to its wave budget.
 *
 * Only those waves are awaited. SvelteKit keeps the previous page on screen
 * until a navigation's `load` resolves, so everything awaited here is time
 * the click appears to do nothing; the panels below the fold stream in as
 * promises instead. Keep the awaited set small: anything moved out of
 * `deferred` puts itself back on the navigation critical path.
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
	// Wave A, one statement: the addressed project with the viewer's
	// membership, the owner's name (a member acts with the owner's scope), and
	// the issue the address points at. Access is decided from this row, not
	// from a round trip of its own. The project segment is matched as an id
	// or as a name in the same statement: lists link by name, and resolving
	// the name first cost three more round trips on every click.
	const ref = params.project;
	const candidates = await db
		.selectFrom('project as p')
		.innerJoin('user as owner', 'owner.id', 'p.user_id')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', viewerId)
		)
		.leftJoin('issue_address as a', (join) =>
			join.onRef('a.project_id', '=', 'p.id').on('a.number', '=', number)
		)
		.leftJoin('issue as i', 'i.id', 'a.issue_id')
		.select([
			'p.id',
			'p.name',
			'p.user_id',
			'p.shared_at',
			'p.sharing_revision',
			'p.archived_at',
			'm.revision',
			'm.revoked_at',
			'owner.name as owner_name',
			'a.issue_id',
			'i.project_id as issue_project_id',
			'i.workflow_id as issue_workflow_id',
			'i.state_id as issue_state_id'
		])
		.where((eb) =>
			eb.or([
				eb('p.id', '=', ref),
				// A name resolves only within the viewer's accessible set, as
				// resolveAccessibleProjectRef does.
				eb.and([
					eb('p.name', '=', ref),
					eb.or([
						eb('p.user_id', '=', viewerId),
						eb.and([
							eb('p.shared_at', 'is not', null),
							eb('m.revision', 'is not', null),
							eb('m.revoked_at', 'is', null)
						])
					])
				])
			])
		)
		.execute();
	// Immutable ids win; an ambiguous name gets the shared resolver's 409.
	const named = candidates.filter((row) => row.id !== ref);
	const address =
		candidates.find((row) => row.id === ref) ??
		(named.length > 1
			? await resolveAccessibleProjectRef(db, actor, ref).then(
					(id) => named.find((row) => row.id === id),
					(e) => {
						if (e instanceof ApiFail) error(e.status, e.message);
						throw e;
					}
				)
			: named[0]);
	if (!address) error(404, `You have no project named “${truncate(params.project)}”.`);
	const addressAccess = (() => {
		try {
			return projectAccessFromRow(actor, address.id, address);
		} catch (e) {
			if (e instanceof ApiFail) error(e.status, e.message);
			throw e;
		}
	})();
	if (!address.issue_id || !address.issue_project_id)
		error(404, `Issue #${number} does not exist in “${truncate(address.name)}”.`);
	const issueId = address.issue_id;
	// An address outlives a transfer: the issue now lives in another project,
	// whose access is checked in its own right (rare, so it pays its own trip).
	const access =
		address.issue_project_id === address.id
			? addressAccess
			: await resolveIssueAccess(db, actor, issueId).catch((e) => {
					if (e instanceof ApiFail) error(e.status, e.message);
					throw e;
				});
	// A member sees the owner's page for a shared issue, loaded with the
	// owner's scope. What stays the owner's (runners, routing, run logs, the
	// launch prompt, account-wide context and spend) is left out below.
	const isMember = access.role === 'member';
	const scopeActor =
		access === addressAccess
			? memberActor(actor, access, address.owner_name)
			: isMember
				? await actorForProject(db, actor, access.projectId)
				: actor;
	const userId = scopeActor.userId;

	// Wave B: the issue row and everything that needs only its id, at once.
	const sharedPromise =
		access === addressAccess
			? Promise.resolve(address.shared_at != null)
			: db
					.selectFrom('project')
					.select('shared_at')
					.where('id', '=', access.projectId)
					.where('user_id', '=', userId)
					.executeTakeFirst()
					.then((row) => row?.shared_at != null);
	const workflowsPromise = loadWorkflows(db, userId);
	const issuePromise = loadIssue(db, userId, { id: issueId });
	const eventsPromise = eventQuery(db, userId)
		.where('event.issue_id', '=', issueId)
		.orderBy('event.created_at desc')
		.orderBy('event.id desc')
		.limit(100)
		.execute()
		.then((rows) => rows.map(serializeEvent));
	// The whole vocabulary, for the labels picker in the aside.
	const labelsPromise = listLabelsInternal(db, userId);
	const receiptPromise = sharedPromise.then((shared) =>
		shared ? readIssueConsent(db, viewerId, issueId) : null
	);
	const rosterPromise = sharedPromise.then((shared) =>
		shared ? listIssuePermissionRoster(db, issueId) : []
	);
	// The detail's own reads (comments, links, context summary, artifacts) key
	// off the head from wave A, so they start now, alongside the row.
	const detailPromise = getIssueDetail(
		db,
		userId,
		{
			head: {
				id: issueId,
				project_id: address.issue_project_id,
				workflow_id: address.issue_workflow_id!,
				state_id: address.issue_state_id!
			},
			issue: issuePromise
		},
		{ workflows: workflowsPromise, artifacts: true }
	);
	// Nothing awaits these until the issue row lands; a rejection in the
	// meantime would otherwise be unhandled.
	for (const p of [
		workflowsPromise,
		eventsPromise,
		labelsPromise,
		receiptPromise,
		rosterPromise,
		detailPromise
	])
		p.catch(() => {});

	const issue = await issuePromise.catch(async () => {
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
	const canonicalPath = `/issues/${encodeURIComponent(issue.project_id)}/${issue.number}`;
	if (!isDataRequest && url.pathname !== canonicalPath) {
		// A native document redirect retains the browser fragment. Client data
		// navigations are canonicalized in +page.svelte where the hash is visible.
		redirect(307, `${canonicalPath}${url.search}`);
	}

	const [detail, events, labelLibrary, permissionReceipt, permissionRoster] = await Promise.all([
		detailPromise,
		eventsPromise,
		labelsPromise,
		receiptPromise,
		rosterPromise
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
			// In a shared project (flag on) owner and member both see the one
			// projection agents receive; a bundle that cannot be delivered whole
			// says why instead.
			effectiveContext: (sharedExecutionEnabled(platform!.env)
				? sharedPromise
				: Promise.resolve(false)
			).then((shared): Promise<IssueGuidancePanel | null> | null => {
				if (shared)
					return loadSharedExecutionBundle(platform!.env, db, {
						issueId: issue.id,
						skillFiles: false
					}).then(
						({ bundle }) => ({ context: bundle.guidance, shared: true, failure: null }),
						(e: unknown) => {
							if (e instanceof ApiFail && e.code.startsWith('bundle_'))
								return { context: null, shared: true, failure: bundleFailureText(e) };
							throw e;
						}
					);
				if (isMember) return null;
				return effectiveContextForIssue(db, userId, issue.id, { skillFiles: false }).then(
					(context) => ({ context, shared: false, failure: null })
				);
			}),
			// Routing and runner verdicts describe the owner's machines.
			dispatch: isMember
				? ownerOnly(null)
				: explainDispatch(db, userId, issue.id, Date.now(), issue),
			issueRuns: listRuns(db, userId, { issue: issue.id }, { cursor: null, limit: 20 }).then(
				(page) => (isMember ? page.items.map((run) => ({ ...run, usage: null })) : page.items)
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
