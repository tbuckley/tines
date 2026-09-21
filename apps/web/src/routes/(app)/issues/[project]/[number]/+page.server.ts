import { error, redirect } from '@sveltejs/kit';
import { truncate } from '$lib/format';
import { effectiveContextForIssue, listContextItems } from '$lib/server/api/context';
import { eventQuery, serializeEvent } from '$lib/server/api/events';
import { getIssueDetail, loadIssue } from '$lib/server/api/issues';
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
	const userId = locals.user!.id;
	const actor = sessionActor(locals.user!);

	// Mutations and the live poll refresh this page alone (see +page.svelte);
	// invalidateAll() would also re-run the layout for no reason.
	depends('app:issue');

	// Issue numbers are 1-based; "abc" and "-1" are addresses, not issues.
	const number = Number.parseInt(params.number, 10);
	if (!Number.isInteger(number) || number < 1)
		error(404, `“${truncate(params.number)}” is not an issue number.`);

	// Wave 1: the issue row (URLs address projects by name, joined here so the
	// project resolve is not a round trip of its own) alongside the two lists
	// that do not depend on it.
	const workflowsPromise = loadWorkflows(db, userId);
	// A rejected promise that nothing awaits until wave 2 would be an unhandled
	// rejection if the issue lookup throws first.
	workflowsPromise.catch(() => {});

	const issue = await loadIssue(db, userId, { projectName: params.project, number }).catch(
		async () => {
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
		}
	);
	const canonicalPath = `/issues/${encodeURIComponent(issue.project_name)}/${issue.number}`;
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
	const { artifacts, ...issueDetail } = detail;

	// Awaited by two deferred entries; created once so the check is not made twice.
	const hasAnyRunPromise = hasAnyRun(db, userId);
	hasAnyRunPromise.catch(() => {});
	const usagePromise = (async () => {
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

	return {
		issue: issueDetail,
		canonicalPath,
		events,
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
				actor,
				{ issue: issue.id },
				{ cursor: null, limit: 100 }
			).then((page) => page.items.filter((i) => i.kind !== 'artifact')),
			// Display-only bundle: the panel shows skill file counts, never their
			// contents, which can run to 100KB per skill on every page load.
			effectiveContext: effectiveContextForIssue(db, userId, issue.id, { skillFiles: false }),
			dispatch: explainDispatch(db, userId, issue.id, Date.now(), issue),
			issueRuns: listRuns(db, userId, { issue: issue.id }, { cursor: null, limit: 20 }).then(
				(page) => page.items
			),
			usage: usagePromise,
			runners: listRunners(db, userId),
			// The first-run checklist: shown only while the account has never had
			// a run, so the rules it needs are fetched only for that population —
			// a steady-state page pays one existence check and nothing else.
			hasAnyRun: hasAnyRunPromise,
			rules: hasAnyRunPromise.then((has) => (has ? [] : listRoutingRules(db, userId)))
		}
	};
};
