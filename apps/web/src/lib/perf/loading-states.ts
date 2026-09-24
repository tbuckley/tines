/**
 * Every place the app may show a loading placeholder, with why it is allowed
 * (docs/PERFORMANCE.md, "Loading states"). The goal is a navigation that
 * lands complete; a placeholder is the exception, so each one is named here,
 * rendered through `LoadingState.svelte`, and counted in production
 * telemetry. `loading-states.test.ts` fails on a `Skeleton` outside a
 * `LoadingState`, on an id missing from this list, and on an entry nothing
 * uses.
 */
export const LOADING_STATES = {
	'issue.context-items':
		"Issue sidebar: the issue's context items stream after first paint so the header and comments are not held back.",
	'issue.effective-context':
		'Issue sidebar: the effective context bundle is several reads deep and collapsed by default.',
	'issue.agent-activity':
		'Issue sidebar: dispatch explanation, runs and runners stream after first paint.',
	'issue.usage': 'Issue sidebar: lifetime spend aggregates every run on the issue.',
	'activity.load-more': 'Activity: the next page, fetched only when the reader asks for more.'
} as const;

export type LoadingStateId = keyof typeof LOADING_STATES;
