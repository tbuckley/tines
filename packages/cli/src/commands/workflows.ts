/** `tines workflows` — the workflow library: states, transitions, and their gates. */
import { readFileSync } from 'node:fs';
import {
	client,
	die,
	fetchList,
	pickWorkflow,
	printJson,
	printList,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { formatTable } from '../format.js';
import { assertNewStatesHavePrompts, parseJsonObject } from '../refs.js';
import {
	buildStateLibrary,
	childrenOf,
	listAll,
	qualifyEntry,
	qualifyState,
	type ApiClient,
	type CreateWorkflowRequest,
	type LibraryState,
	type StateLibrary,
	type UpdateWorkflowRequest,
	type WorkflowResponse,
	type WorkflowState
} from '@tines/shared';
import type { Command } from 'commander';

// ---------------------------------------------------------------------------
// JSON body input (inline argument, --file <path>, --file -, or piped stdin)

/**
 * Reads a JSON request body from, in order of precedence: the inline
 * argument, --file <path> ("-" for stdin), or piped stdin. Returns undefined
 * when no source provided anything.
 */
function readJsonBody(
	inline: string | undefined,
	file: string | undefined
): Record<string, unknown> | undefined {
	if (inline !== undefined && file !== undefined) {
		die('pass the JSON inline or with --file, not both');
	}
	if (inline !== undefined) return parseJsonObject(inline, 'the argument');
	if (file !== undefined && file !== '-') {
		let raw: string;
		try {
			raw = readFileSync(file, 'utf8');
		} catch (err) {
			die(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
		return parseJsonObject(raw, file);
	}
	if (file === '-' || !process.stdin.isTTY) {
		const raw = readFileSync(0, 'utf8');
		if (raw.trim() === '') {
			if (file === '-') die('no JSON on stdin');
			return undefined;
		}
		return parseJsonObject(raw, 'stdin');
	}
	return undefined;
}

const WORKFLOW_JSON_HELP = `
The JSON body may be passed inline, via --file <path>, --file - (stdin), or
piped on stdin. Shape:

  {
    "name": "Review",
    "description": "Two-step review",
    "initial_state": "Draft",
    "states": [
      { "name": "Draft", "category": "active", "prompt": "Drafting means…" },
      { "name": "In review", "category": "awaiting_human", "prompt": "Review checklist…" },
      { "name": "Done", "category": "done", "prompt": "…" }
    ],
    "transitions": [
      { "name": "submit", "from": "Draft", "to": "In review" },
      { "name": "approve", "from": "In review", "to": "Done" },
      { "name": "send back", "from": "In review", "to": "Draft" }
    ]
  }

Categories: backlog, active, awaiting_human, done. On edit, a state with an
"id" updates that existing state; states/transitions arrays replace the
existing sets wholesale when present.

Each NEW state should carry a "prompt" — its initial stage instructions,
created as a state-scoped context item — or pass --no-prompts to skip.

A state may inherit context from another state — its base — with
"inherits_from". Give the base as "<workflow>/<state>" (the qualified form
\`tines workflows show\` prints, so it can be pasted straight back in), as a
bare state name to mean one of this same request's states, or as a state id:

  { "id": "wfs_abc", "name": "Merging", "category": "active",
    "inherits_from": "Engineering/Review" }

Items scoped to the base are part of an issue's context in the child state,
stitched before the child's own layer. Chains are at most 3 states long and
may not cycle. On an EXISTING state (one with an "id") the field is
merge-patch: leaving it out keeps the current base, and "inherits_from": null
clears it. See \`tines workflows bases\` for the pointers already in place.

A transition may declare artifact requirements ("requires"): it can then only
be taken once a FRESH artifact with that name — attached (or reaffirmed)
since the issue entered its current state — exists on the issue:

  { "name": "approve", "from": "In review", "to": "Done",
    "requires": [ { "artifact": "design-doc", "type": "file",
                    "content_type": "text/markdown",
                    "description": "The approved design for this round" } ] }

"type" (file | text | link | pr) and "content_type" (a prefix match, e.g.
"image/"; file/text only) are optional narrowing; "artifact" is the slot
name issues must carry (see: tines issues artifacts --help).
`;

// ---------------------------------------------------------------------------
// State inheritance (Tines/240)

/** The library, indexed by state id — a base may live in another workflow. */
type Library = StateLibrary<WorkflowResponse>;

const loadLibrary = async (api: ApiClient): Promise<Library> =>
	buildStateLibrary(await listAll((page) => api.listWorkflows(page)));

/** The `inherits from:` / `inherited by:` lines under one state, in `show` order. */
function inheritanceLines(lib: Library, state: WorkflowState): string[] {
	const lines: string[] = [];
	if (state.inherits_from !== null) {
		lines.push(`    inherits from: ${qualifyState(lib, state.inherits_from)}`);
	}
	const kids = childrenOf(lib, state.id);
	if (kids.length > 0) lines.push(`    inherited by: ${kids.map(qualifyEntry).join(', ')}`);
	return lines;
}

/**
 * Rewrites every `inherits_from: "<workflow>/<state>"` among a request's
 * states into the state id the API takes. A value with no `/` is left alone:
 * the API resolves a bare name against the request's own states, and an id is
 * already what it wants. Spaces around the separator are tolerated so the
 * form `workflows show` prints can be pasted straight back in.
 *
 * `library` is called at most once, and only if some state names a pair, so a
 * body with no pair costs no fetch it would not otherwise make.
 */
async function resolveStateBases(states: unknown, library: () => Promise<Library>): Promise<void> {
	if (!Array.isArray(states)) return;
	let lib: Library | undefined;
	for (const entry of states) {
		if (typeof entry !== 'object' || entry === null) continue;
		const state = entry as { name?: unknown; inherits_from?: unknown };
		if (typeof state.inherits_from !== 'string' || !state.inherits_from.includes('/')) continue;
		lib ??= await library();
		state.inherits_from = resolveBasePair(
			lib,
			state.inherits_from,
			typeof state.name === 'string' ? state.name : '(unnamed)'
		);
	}
}

/** One `<workflow>/<state>` pair → a state id, or a message naming the pair. */
function resolveBasePair(lib: Library, pair: string, stateName: string): string {
	const sep = pair.indexOf('/');
	const workflowRef = pair.slice(0, sep).trim();
	const stateRef = pair.slice(sep + 1).trim();
	const where = `state "${stateName}" inherits from "${pair}"`;
	if (!workflowRef || !stateRef) {
		die(`${where}, which is not a <workflow>/<state> pair`);
	}
	const byName = lib.workflows.filter((w) => w.name === workflowRef);
	if (byName.length > 1)
		die(`${where}, but workflow name "${workflowRef}" is ambiguous; use an id`);
	const workflow = lib.workflows.find((w) => w.id === workflowRef) ?? byName[0];
	if (!workflow) {
		die(
			`${where}, but there is no workflow "${workflowRef}" (have: ${lib.workflows.map((w) => w.name).join(', ')})`
		);
	}
	const state =
		workflow.states.find((s) => s.name === stateRef) ??
		workflow.states.find((s) => s.id === stateRef);
	if (!state) {
		die(
			`${where}, but workflow "${workflow.name}" has no state "${stateRef}" (have: ${workflow.states.map((s) => s.name).join(', ')})`
		);
	}
	return state.id;
}

function printWorkflowDetail(wf: WorkflowResponse, lib: Library): void {
	console.log(`${wf.name}${wf.is_system ? ' (standard, read-only)' : ''}  [${wf.id}]`);
	if (wf.description) console.log(wf.description);
	console.log('\nstates:');
	const byId = new Map(wf.states.map((s) => [s.id, s]));
	// Rendered as one table, then split apart again, so a state's inheritance
	// sits under its own row without costing the columns their alignment —
	// the shape a transition's requirements already have below.
	const rows =
		wf.states.length === 0
			? []
			: formatTable(
					wf.states.map((s) => [
						`  ${s.name}`,
						s.category,
						s.id === wf.initial_state_id ? '(initial)' : ''
					])
				).split('\n');
	for (const [i, row] of rows.entries()) {
		console.log(row);
		for (const line of inheritanceLines(lib, wf.states[i])) console.log(line);
	}
	console.log('\ntransitions:');
	for (const t of wf.transitions) {
		console.log(
			`  "${t.name}": ${byId.get(t.from_state_id)?.name} → ${byId.get(t.to_state_id)?.name}`
		);
		for (const r of t.requires ?? []) {
			const spec = [r.type, r.content_type].filter(Boolean).join(', ');
			console.log(
				`    requires artifact "${r.artifact}"${spec ? ` (${spec})` : ''}${r.description ? ` — ${r.description}` : ''}`
			);
		}
	}
	for (const w of wf.warnings ?? []) console.log(`\nwarning: ${w}`);
}

export function register(program: Command): void {
	const workflows = program.command('workflows').description('Manage the workflow library');

	withList(workflows.command('list').description('List the workflow library')).action(
		async (opts: ListOpts) => {
			const api = client(opts);
			const res = await fetchList(opts, (page) => api.listWorkflows(page));
			printList(res, opts, (items) => {
				if (items.length === 0) return console.log('no workflows');
				table([
					['NAME', 'STATES', 'ISSUES', 'ID', ''],
					...items.map((w) => [
						w.name,
						String(w.states.length),
						String(w.issue_count),
						w.id,
						w.is_system ? '(standard, read-only)' : ''
					])
				]);
			});
		}
	);

	withCommon(
		workflows
			.command('show <id-or-name>')
			.description('Show a workflow with states and transitions')
	).action(async (ref: string, opts: CommonOpts) => {
		// The whole library, because a base — and the states inheriting from
		// this one — may live in another workflow.
		const lib = await loadLibrary(client(opts));
		const wf = pickWorkflow(lib.workflows, ref);
		if (opts.json) return printJson(wf);
		printWorkflowDetail(wf, lib);
	});

	withCommon(
		workflows
			.command('bases')
			.description('List the states other states inherit context from, with their children')
	).action(async (opts: CommonOpts) => {
		const lib = await loadLibrary(client(opts));
		// Library order, so the bases arrive already grouped by workflow.
		const bases = [...lib.states.values()].filter((e) => lib.children.has(e.state.id));
		if (opts.json) {
			const ref = (e: LibraryState<WorkflowResponse>) => ({
				workflow: { id: e.workflow.id, name: e.workflow.name },
				state: { id: e.state.id, name: e.state.name }
			});
			return printJson(
				bases.map((b) => ({
					...ref(b),
					inherited_by: childrenOf(lib, b.state.id).map(ref)
				}))
			);
		}
		if (bases.length === 0) return console.log('no base states');
		let group: string | undefined;
		for (const base of bases) {
			if (base.workflow.id !== group) {
				console.log(`${group === undefined ? '' : '\n'}${base.workflow.name}`);
				group = base.workflow.id;
			}
			console.log(`  ${base.state.name}`);
			console.log(
				`    inherited by: ${childrenOf(lib, base.state.id).map(qualifyEntry).join(', ')}`
			);
		}
	});

	withCommon(
		workflows
			.command('create [json]')
			.description(
				'Create a workflow from a JSON definition (states carry initial "prompt" instructions)'
			)
			.option('-f, --file <path>', 'read the JSON definition from a file ("-" for stdin)')
			.option('--no-prompts', 'allow states without initial "prompt" instructions')
			.addHelpText('after', WORKFLOW_JSON_HELP)
	).action(
		async (inline: string | undefined, opts: CommonOpts & { file?: string; prompts?: boolean }) => {
			const body = readJsonBody(inline, opts.file);
			if (!body) {
				die(
					'missing workflow JSON: pass it inline, with --file <path>, or pipe it on stdin' +
						`\nsee \`tines workflows create --help\` for the expected shape`
				);
			}
			assertNewStatesHavePrompts(body.states, opts.prompts);
			const api = client(opts);
			await resolveStateBases(body.states, () => loadLibrary(api));
			const wf = await api.createWorkflow(body as unknown as CreateWorkflowRequest);
			if (opts.json) return printJson(wf);
			console.log(`created workflow "${wf.name}" (${wf.id})\n`);
			// Re-read after the write: the library the pointers are named
			// against now includes this workflow.
			printWorkflowDetail(wf, await loadLibrary(api));
		}
	);

	withCommon(
		workflows
			.command('edit <id-or-name> [json]')
			.description('Update a workflow from a JSON definition and/or flags')
			.option('-f, --file <path>', 'read the JSON definition from a file ("-" for stdin)')
			.option('-n, --name <name>', 'rename the workflow')
			.option('-d, --description <text>', 'set the description')
			.option('--initial-state <id-or-name>', 'set the initial state')
			.option('--no-prompts', 'allow new states without initial "prompt" instructions')
			.addHelpText('after', WORKFLOW_JSON_HELP)
	).action(
		async (
			ref: string,
			inline: string | undefined,
			opts: CommonOpts & {
				file?: string;
				name?: string;
				description?: string;
				initialState?: string;
				prompts?: boolean;
			}
		) => {
			const api = client(opts);
			// One library load answers both the ref and any `<workflow>/<state>`
			// base the body names.
			const lib = await loadLibrary(api);
			const wf = pickWorkflow(lib.workflows, ref);
			const body = (readJsonBody(inline, opts.file) ?? {}) as UpdateWorkflowRequest;
			assertNewStatesHavePrompts(body.states, opts.prompts);
			await resolveStateBases(body.states, async () => lib);
			if (opts.name !== undefined) body.name = opts.name;
			if (opts.description !== undefined) body.description = opts.description;
			if (opts.initialState !== undefined) body.initial_state = opts.initialState;
			if (Object.keys(body).length === 0) {
				die('nothing to update: pass JSON and/or --name/--description/--initial-state');
			}
			const updated = await api.updateWorkflow(wf.id, body);
			if (opts.json) return printJson(updated);
			console.log(`updated workflow "${updated.name}" (${updated.id})\n`);
			printWorkflowDetail(updated, await loadLibrary(api));
		}
	);

	withCommon(
		workflows
			.command('delete <id-or-name>')
			.description('Delete a workflow (refused while issues still reference it)')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const wf = await resolveWorkflow(api, ref);
		await api.deleteWorkflow(wf.id);
		console.log(`deleted workflow "${wf.name}" (${wf.id})`);
	});
}
