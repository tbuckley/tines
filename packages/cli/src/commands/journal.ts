/**
 * `tines journal` — the id-free path to the one item agents maintain routinely:
 * the prompt named "journal" at exactly project ∧ state. The state is the one
 * this run was launched in — not the issue's current state — so a lesson stays
 * with the stage that learned it even after the issue has moved on.
 */
import { BODY_VALUE_HELP, readBodyValue } from '../body-value.js';
import {
	client,
	die,
	printJson,
	resolveIssue,
	resolveStateFlag,
	withCommon,
	type CommonOpts
} from '../common.js';
import { helpGuard } from '../help-guard.js';

import {
	ApiError,
	JOURNAL_NAME,
	listAll,
	type ApiClient,
	type ContextItem,
	type ContextScope,
	type IssueDetail
} from '@tines/shared';
import type { Command } from 'commander';

const STATE_FLAG_HELP =
	"target this state's journal instead of your run's launch stage (options go BEFORE <ref>)";

interface ResolvedJournal {
	issue: IssueDetail;
	/** The project ∧ state the commands target. */
	scope: ContextScope;
	/** Set when a run key was present but could not anchor; worth printing. */
	note: string | null;
	item: ContextItem | null;
}

/** The `journal` item at an already-resolved project ∧ state scope. */
async function journalItemAt(api: ApiClient, scope: ContextScope): Promise<ContextItem | null> {
	const items = await listAll((page) =>
		api.listContext({
			kind: 'prompt',
			project: scope.project_id ?? undefined,
			state: scope.workflow_state_id ?? undefined,
			exact: true,
			...page
		})
	);
	return items.find((i) => i.name === JOURNAL_NAME) ?? null;
}

function stateScope(
	issue: IssueDetail,
	state: { id: string; name: string },
	workflow: { id: string; name: string }
): ContextScope {
	return {
		project_id: issue.project_id,
		project_name: issue.project_name,
		workflow_state_id: state.id,
		workflow_state_name: state.name,
		workflow_id: workflow.id,
		workflow_name: workflow.name,
		issue_id: null,
		issue_ref: null,
		label_id: null,
		label_name: null,
		label_color: null,
		label: `project ${issue.project_name} · state ${state.name}`
	};
}

/**
 * Which journal a command targets. The server decides by default — it alone
 * can see that this key is a run key and which state its run started in —
 * unless `--state` names one explicitly.
 */
async function resolveJournal(
	api: ApiClient,
	ref: string,
	stateRef?: string
): Promise<ResolvedJournal> {
	const issue = await resolveIssue(api, ref);
	if (stateRef !== undefined) {
		const { workflow, state } = await resolveStateFlag(api, stateRef);
		const scope = stateScope(issue, state, workflow);
		return { issue, scope, note: null, item: await journalItemAt(api, scope) };
	}
	try {
		const { scope, note, item } = await api.getIssueJournal(issue.id);
		return { issue, scope, note, item };
	} catch (err) {
		// Rollout insurance only: a CLI newer than the server it is pointed at
		// has no /journal endpoint, so fall back to the issue's current state.
		if (!(err instanceof ApiError) || err.status !== 404) throw err;
		if (!issue.workflow)
			throw new ApiError(
				403,
				{
					code: 'insufficient_permissions',
					message: 'Journal fallback requires workspace read access'
				},
				'Journal fallback requires workspace read access'
			);
		const scope = stateScope(issue, issue.state, issue.workflow);
		return { issue, scope, note: null, item: await journalItemAt(api, scope) };
	}
}

/** The anchor note is advice, not output: stderr keeps `--json` pure. */
function printNote(note: string | null): void {
	if (note) console.error(`note: ${note}`);
}

export function register(program: Command): void {
	const journal = program
		.command('journal')
		.description(
			"An issue's stage journal: shared notes for its project + the stage your run was launched in"
		);

	withCommon(
		journal
			.command('show <ref>')
			.description('Print the journal for the stage your run was launched in')
			.option('--state <workflow>/<state>', STATE_FLAG_HELP)
	).action(async (ref: string, opts: CommonOpts & { state?: string }) => {
		const api = client(opts);
		const { issue, scope, note, item } = await resolveJournal(api, ref, opts.state);
		printNote(note);
		if (!item) {
			die(
				`no journal exists yet for ${scope.label}\nstart one: tines journal append ${issue.project_name}/${issue.number} "- <date>: <lesson>"`
			);
		}
		const full = await api.getContextItem(item.id);
		if (opts.json) return printJson(full);
		console.log(`journal for ${scope.label}  (v${full.version})`);
		console.log('');
		console.log(full.body ?? '');
	});

	withCommon(
		journal
			.command('append <ref> <markdown>')
			.description(`Append a lesson, creating the journal on first use — ${BODY_VALUE_HELP}`)
			.option('--state <workflow>/<state>', STATE_FLAG_HELP)
			// Lessons are dated bullets starting with "-"; options go before the
			// arguments, exactly as the launch prompt's copy-pasteable command has it.
			.passThroughOptions()
	).action(
		async (
			ref: string,
			markdown: string,
			opts: CommonOpts & { state?: string },
			command: Command
		) => {
			if (helpGuard(command, markdown)) return;
			// Resolved once: stdin is single-consumption and all three paths below
			// (append, first-use create, create-race recovery) need the same body.
			const text = readBodyValue(markdown);
			const api = client(opts);
			const { scope, note, item } = await resolveJournal(api, ref, opts.state);
			printNote(note);
			if (item) {
				const updated = await api.appendContextItem(item.id, { text });
				if (opts.json) return printJson(updated);
				return console.log(`appended to the ${scope.label} journal (now v${updated.version})`);
			}
			try {
				const created = await api.createContextItem({
					kind: 'prompt',
					name: JOURNAL_NAME,
					project_id: scope.project_id ?? undefined,
					workflow_state_id: scope.workflow_state_id ?? undefined,
					body: text.trim()
				});
				if (opts.json) return printJson(created);
				console.log(`started the ${scope.label} journal (${created.id})`);
			} catch (err) {
				// Create race: someone else started the journal between the lookup
				// and the insert — append to theirs instead.
				if (!(err instanceof ApiError) || err.code !== 'duplicate_context_name') throw err;
				const { item: fresh } = await resolveJournal(api, ref, opts.state);
				if (!fresh) throw err;
				const updated = await api.appendContextItem(fresh.id, { text });
				if (opts.json) return printJson(updated);
				console.log(`appended to the ${scope.label} journal (now v${updated.version})`);
			}
		}
	);

	withCommon(
		journal
			.command('rewrite <ref>')
			.description('Replace the journal body (to fix or prune entries) — version-checked')
			.option('--state <workflow>/<state>', STATE_FLAG_HELP)
			.requiredOption('--body <md>', 'the full new body: inline Markdown or @file')
			.requiredOption(
				'--expect-version <n>',
				'the version being replaced (from the prompt or journal show)',
				(v) => Number.parseInt(v, 10)
			)
	).action(
		async (
			ref: string,
			opts: CommonOpts & { body: string; expectVersion: number; state?: string }
		) => {
			const api = client(opts);
			const { scope, note, item } = await resolveJournal(api, ref, opts.state);
			printNote(note);
			if (!item) die(`no journal exists yet for ${scope.label}; nothing to rewrite`);
			const updated = await api.updateContextItem(item.id, {
				body: readBodyValue(opts.body),
				expected_version: opts.expectVersion
			});
			if (opts.json) return printJson(updated);
			console.log(`rewrote the ${scope.label} journal (now v${updated.version})`);
		}
	);
}
