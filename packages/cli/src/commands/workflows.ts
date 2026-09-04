/** `tines workflows` — the workflow library: states, transitions, and their gates. */
import { readFileSync } from 'node:fs';
import {
	client,
	die,
	fetchList,
	printJson,
	printList,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { assertNewStatesHavePrompts, parseJsonObject } from '../refs.js';
import {
	type CreateWorkflowRequest,
	type UpdateWorkflowRequest,
	type WorkflowResponse
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

function printWorkflowDetail(wf: WorkflowResponse): void {
	console.log(`${wf.name}${wf.is_system ? ' (standard, read-only)' : ''}  [${wf.id}]`);
	if (wf.description) console.log(wf.description);
	console.log('\nstates:');
	const byId = new Map(wf.states.map((s) => [s.id, s]));
	table(
		wf.states.map((s) => [
			`  ${s.name}`,
			s.category,
			s.id === wf.initial_state_id ? '(initial)' : ''
		])
	);
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
		const api = client(opts);
		const wf = await resolveWorkflow(api, ref);
		if (opts.json) return printJson(wf);
		printWorkflowDetail(wf);
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
			const wf = await client(opts).createWorkflow(body as unknown as CreateWorkflowRequest);
			if (opts.json) return printJson(wf);
			console.log(`created workflow "${wf.name}" (${wf.id})\n`);
			printWorkflowDetail(wf);
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
			const wf = await resolveWorkflow(api, ref);
			const body = (readJsonBody(inline, opts.file) ?? {}) as UpdateWorkflowRequest;
			assertNewStatesHavePrompts(body.states, opts.prompts);
			if (opts.name !== undefined) body.name = opts.name;
			if (opts.description !== undefined) body.description = opts.description;
			if (opts.initialState !== undefined) body.initial_state = opts.initialState;
			if (Object.keys(body).length === 0) {
				die('nothing to update: pass JSON and/or --name/--description/--initial-state');
			}
			const updated = await api.updateWorkflow(wf.id, body);
			if (opts.json) return printJson(updated);
			console.log(`updated workflow "${updated.name}" (${updated.id})\n`);
			printWorkflowDetail(updated);
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
