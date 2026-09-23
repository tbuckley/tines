/** `tines workflows` — the workflow library: states, transitions, and their gates. */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
	client,
	die,
	fetchList,
	pickWorkflow,
	printJson,
	printList,
	resolveProject,
	resolveUrl,
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
	listAll,
	parsePublicSnapshotReference,
	ApiError,
	type PublicationProof,
	type PublicationSource,
	type ExportWorkflowPackageOptions,
	type ApiClient,
	type CreateWorkflowRequest,
	type UpdateWorkflowRequest,
	type WorkflowResponse
} from '@tines/shared';
import type { Command } from 'commander';
import {
	askToInstall,
	canonicalWorkflowPackage,
	formatValidation,
	formatWorkflowPackageReview,
	localDocument,
	packageDocument,
	readPackageSource,
	readStrictObject,
	readWorkflowPackagePlan,
	recoverOrInstall,
	saveWorkflowPackagePlan,
	workflowPackageBytesSha256,
	type WorkflowPackageChoices
} from '../workflow-packages.js';
import { fetchPublicWorkflowPackage } from '../publication-fetch.js';
import { writeJsonFile } from '../config.js';

interface SavedPublicationProof {
	format: 'tines.workflow-publication-proof';
	version: 1;
	api_base: string;
	proof: PublicationProof;
}

function savePublicationProof(path: string, apiBase: string, proof: PublicationProof) {
	const saved: SavedPublicationProof = {
		format: 'tines.workflow-publication-proof',
		version: 1,
		api_base: normalizeUrl(apiBase),
		proof
	};
	writeJsonFile(path, saved, { secret: true });
	return saved;
}

function readPublicationProof(path: string): SavedPublicationProof {
	const saved = readStrictObject<SavedPublicationProof>(path, 'publication proof');
	if (
		saved.format !== 'tines.workflow-publication-proof' ||
		saved.version !== 1 ||
		typeof saved.api_base !== 'string' ||
		!saved.proof ||
		typeof saved.proof.candidate_id !== 'string' ||
		typeof saved.proof.review_digest !== 'string'
	)
		die('invalid workflow publication proof file');
	return saved;
}

export interface WorkflowExportSelectorOpts {
	project?: string;
	schedule: string[];
	tier: string[];
	projectRouting?: boolean;
	inputs?: string;
}

function withWorkflowExportSelectors(cmd: Command): Command {
	return cmd
		.option('--project <id-or-name>', 'source project for selected project-bound configuration')
		.option('--schedule <id>', 'include this source schedule ID (repeatable)', collect, [])
		.option('--tier <state-ref=tier>', 'include a state tier preference (repeatable)', collect, [])
		.option('--project-routing', 'make every --tier selector project scoped')
		.option('--inputs <file>', 'JSON object containing input declarations and text uses');
}

function hasWorkflowExportSelectors(opts: WorkflowExportSelectorOpts): boolean {
	return Boolean(
		opts.project || opts.schedule.length || opts.tier.length || opts.projectRouting || opts.inputs
	);
}

export async function resolveWorkflowExportSelection(
	api: ApiClient,
	workflowRef: string,
	opts: WorkflowExportSelectorOpts
): Promise<{ workflow: WorkflowResponse; options: ExportWorkflowPackageOptions }> {
	const all = await listAll((page) => api.listWorkflows(page));
	const workflow = pickWorkflow(all, workflowRef);
	const sourceProject = opts.project ? await resolveProject(api, opts.project) : undefined;
	if ((opts.schedule.length || opts.projectRouting) && !sourceProject)
		die('--project is required with --schedule or --project-routing');
	const tiers: ExportWorkflowPackageOptions['tiers'] = [];
	for (const selector of opts.tier) {
		const separator = selector.lastIndexOf('=');
		if (separator < 1) die(`invalid --tier "${selector}"; expected <state-ref>=<tier>`);
		const tier = selector.slice(separator + 1);
		if (!['smartest', 'balanced', 'cheapest'].includes(tier))
			die(`invalid tier "${tier}"; expected smartest, balanced, or cheapest`);
		tiers.push({
			state_id: await resolveExportState(api, selector.slice(0, separator)),
			tier: tier as 'smartest' | 'balanced' | 'cheapest',
			project_scoped: Boolean(opts.projectRouting)
		});
	}
	const authoring = opts.inputs
		? readStrictObject<{ inputs: never[]; text_uses: never[] }>(opts.inputs, 'inputs file')
		: undefined;
	return {
		workflow,
		options: {
			source_project_id: sourceProject?.id,
			schedule_ids: opts.schedule,
			tiers,
			authoring
		}
	};
}

async function confirmPublicationAction(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^(?:y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
	} finally {
		rl.close();
	}
}

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

State inheritance is retired. Omit \"inherits_from\" (or set it to null for
portable compatibility); non-null values are rejected by the API before any
state is allocated. Context is exact-state scoped and must be copied through
the reviewed retirement workflow when that is approved.

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
	if (wf.states.length > 0)
		console.log(
			formatTable(
				wf.states.map((s) => [
					`  ${s.name}`,
					s.category,
					s.id === wf.initial_state_id ? '(initial)' : ''
				])
			)
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
	registerPackageCommands(workflows);

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
			const api = client(opts);
			const wf = await api.createWorkflow(body as unknown as CreateWorkflowRequest);
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

const collect = (value: string, previous: string[]) => [...previous, value];

async function resolveExportState(api: ApiClient, ref: string): Promise<string> {
	const all = await listAll((page) => api.listWorkflows(page));
	const exact = all.flatMap((workflow) => workflow.states).find((state) => state.id === ref);
	if (exact) return exact.id;
	if (ref.includes('/')) {
		const separator = ref.indexOf('/');
		const workflow = pickWorkflow(all, ref.slice(0, separator).trim());
		const states = workflow.states.filter(
			(state) => state.name === ref.slice(separator + 1).trim()
		);
		if (states.length === 1) return states[0].id;
	}
	const named = all.flatMap((workflow) => workflow.states).filter((state) => state.name === ref);
	if (named.length === 1) return named[0].id;
	if (named.length > 1) die(`state name "${ref}" is ambiguous; use an id`);
	die(`no state named "${ref}"; use a state id or <workflow>/<state>`);
}

function publicationSource(
	value: string,
	apiBase: string
): { kind: 'file' } | { kind: 'hosted'; snapshotId: string } | { kind: 'remote' } {
	if (!/^https?:\/\//i.test(value)) return { kind: 'file' };
	try {
		return {
			kind: 'hosted',
			snapshotId: parsePublicSnapshotReference(value, apiBase)
		};
	} catch (error) {
		if (error instanceof Error && error.message === 'external_source_requires_download')
			return { kind: 'remote' };
		throw error;
	}
}

function registerPackageCommands(workflows: Command): void {
	withCommon(
		workflows
			.command('publication-validate <file>')
			.description('Validate a workflow package for text-only public hosting')
	).action(async (path: string, opts: CommonOpts) => {
		const result = await client(opts).validatePublication({
			document_json: readPackageSource(path)
		});
		if (opts.json) printJson(result);
		else {
			console.log(
				result.valid ? 'valid public workflow snapshot' : 'invalid public workflow snapshot'
			);
			for (const diagnostic of result.diagnostics)
				console.log(`  ${diagnostic.path || '/'}: ${diagnostic.message}`);
		}
		if (!result.valid) process.exitCode = 1;
	});

	withCommon(
		withWorkflowExportSelectors(
			workflows
				.command('publish [workflow]')
				.description('Prepare or commit one exact immutable public workflow snapshot')
				.option(
					'--from <file>',
					'prepare from an existing workflow package instead of an owned workflow'
				)
				.option('--proof-out <file>', 'save the complete prepared proof with mode 0600')
				.option('--proof <file>', 'commit a previously saved exact proof')
				.option('--display-name <name>', 'public attribution name (never an email)')
				.option('--license <license>', 'reuse license (currently MIT)', 'MIT')
				.option('--license-year <year>', 'MIT copyright year', String(new Date().getFullYear()))
				.option('--confirm <review-digest>', 'exact digest of the reviewed proof')
				.option('--sharing-rights', 'confirm rights to every bundled declaration and file')
				.option('--recover', 'reconcile this same candidate after a lost response')
				.option('--repo <local-id>', 'confirm one bundled repository ID (repeatable)', collect, [])
		)
	).action(
		async (
			workflow: string | undefined,
			opts: CommonOpts & {
				from?: string;
				proofOut?: string;
				proof?: string;
				displayName?: string;
				license: string;
				licenseYear: string;
				confirm?: string;
				sharingRights?: boolean;
				recover?: boolean;
				repo: string[];
			} & WorkflowExportSelectorOpts
		) => {
			const apiBase = normalizeUrl(resolveUrl(opts));
			const api = client(opts);
			if ((opts.from || opts.proof) && hasWorkflowExportSelectors(opts))
				die('workflow selectors cannot be combined with --from or --proof');
			if (opts.proof) {
				if (workflow || opts.from || opts.proofOut || opts.displayName)
					die(
						'--proof commit mode cannot be combined with a workflow, --from, --proof-out, or --display-name'
					);
				const saved = readPublicationProof(opts.proof);
				if (normalizeUrl(saved.api_base) !== apiBase)
					die(`proof belongs to ${saved.api_base}, not ${apiBase}`);
				const proof = saved.proof;
				if (opts.confirm && opts.confirm !== proof.review_digest)
					die(`confirmation digest does not match reviewed proof ${proof.review_digest}`);
				if (!process.stdin.isTTY && (opts.confirm !== proof.review_digest || !opts.sharingRights))
					die(`non-interactive publish requires --confirm ${proof.review_digest} --sharing-rights`);
				if (process.stdin.isTTY && opts.confirm !== proof.review_digest) {
					process.stderr.write(`${JSON.stringify(proof, null, 2)}\n`);
					if (!(await confirmPublicationAction('Publish these exact immutable bytes?')))
						die('publication declined');
				}
				if (process.stdin.isTTY && !opts.sharingRights) {
					if (
						!(await confirmPublicationAction('Do you have sharing rights for every bundled item?'))
					)
						die('publication declined');
				}
				let result;
				if (opts.recover) {
					try {
						result = await api.getPublicationResult(proof.candidate_id);
					} catch (error) {
						if (!(error instanceof ApiError) || error.status !== 404) throw error;
					}
				}
				result ??= await api.publishPublication(proof.candidate_id, {
					review_digest: proof.review_digest,
					sharing_rights: true,
					exact_content: true,
					reviewed_repo_ids: opts.repo
				});
				if (opts.json) printJson(result);
				else console.log(`published ${result.receipt.public_url}`);
				return;
			}
			if (opts.recover) die('--recover requires --proof');
			if (!!workflow === !!opts.from) die('provide exactly one owned workflow or --from <file>');
			if (!opts.proofOut) die('preparing a publication requires --proof-out <file>');
			if (!opts.displayName) die('preparing a publication requires --display-name <name>');
			if (opts.license !== 'MIT') die('--license currently supports only MIT');
			const year = Number(opts.licenseYear);
			if (!Number.isSafeInteger(year)) die('--license-year must be an integer');
			let source: PublicationSource;
			if (opts.from) source = { kind: 'file', document_json: readPackageSource(opts.from) };
			else {
				const selected = await resolveWorkflowExportSelection(api, workflow!, opts);
				source = {
					kind: 'owned_workflow',
					workflow_id: selected.workflow.id,
					options: selected.options
				};
			}
			const proof = await api.preparePublication({
				prepare_request_id: crypto.randomUUID(),
				source,
				metadata: { display_name: opts.displayName, license: 'MIT', license_year: year }
			});
			savePublicationProof(opts.proofOut, apiBase, proof);
			if (opts.json) printJson(proof);
			else {
				console.log(JSON.stringify(proof, null, 2));
				console.error(`saved exact publication proof to ${opts.proofOut}`);
			}
		}
	);

	withList(
		workflows
			.command('publications')
			.description('List your public workflow snapshots')
			.option('--workflow <id>', 'filter by owned source workflow ID')
	).action(async (opts: ListOpts & { workflow?: string }) => {
		const result = await fetchList(
			opts,
			(page) => client(opts).listPublications(opts.workflow, page),
			(item) => item.candidate_id
		);
		printList(result, opts, (items) => {
			if (!items.length) return console.log('no public snapshots');
			table([
				['NAME', 'STATUS', 'PUBLISHED', 'SNAPSHOT'],
				...items.map((item) => [
					item.metadata.display_name,
					item.owner_state === 'published' && item.host_state === 'active'
						? 'hosted'
						: 'unavailable',
					new Date(item.published_at).toISOString(),
					item.snapshot_id
				])
			]);
		});
	});

	withCommon(
		workflows
			.command('unpublish <public-url-or-id>')
			.description('Withdraw a hosted public snapshot')
			.option('-y, --yes', 'skip the explicit withdrawal prompt')
	).action(async (reference: string, opts: CommonOpts & { yes?: boolean }) => {
		if (!opts.yes && !process.stdin.isTTY) die('non-interactive withdrawal requires --yes');
		if (!opts.yes && !(await confirmPublicationAction('Withdraw this hosted snapshot now?')))
			die('withdrawal declined');
		const apiBase = normalizeUrl(resolveUrl(opts));
		const snapshotId = /^https?:/i.test(reference)
			? parsePublicSnapshotReference(reference, apiBase)
			: reference;
		const result = await client(opts).withdrawPublication(snapshotId);
		if (opts.json) printJson(result);
		else console.log(`withdrew ${result.receipt.public_url}`);
	});

	withCommon(
		workflows
			.command('restore-publication <public-url-or-id>')
			.description('Restore an owner-withdrawn public snapshot when host policy permits')
			.option('-y, --yes', 'skip the explicit restoration prompt')
	).action(async (reference: string, opts: CommonOpts & { yes?: boolean }) => {
		if (!opts.yes && !process.stdin.isTTY) die('non-interactive restoration requires --yes');
		if (!opts.yes && !(await confirmPublicationAction('Restore this hosted snapshot now?')))
			die('restoration declined');
		const apiBase = normalizeUrl(resolveUrl(opts));
		const snapshotId = /^https?:/i.test(reference)
			? parsePublicSnapshotReference(reference, apiBase)
			: reference;
		const result = await client(opts).restorePublication(snapshotId);
		if (opts.json) printJson(result);
		else console.log(`restored ${result.receipt.public_url}`);
	});

	withCommon(
		withWorkflowExportSelectors(
			workflows
				.command('export <workflow-id-or-unambiguous-name>')
				.description('Export a canonical workflow package JSON document')
		)
	).action(async (ref: string, opts: CommonOpts & WorkflowExportSelectorOpts) => {
		const api = client(opts);
		const selected = await resolveWorkflowExportSelection(api, ref, opts);
		const document = await api.exportWorkflowPackage(selected.workflow.id, selected.options);
		process.stdout.write(`${canonicalWorkflowPackage(document)}\n`);
	});

	withCommon(
		workflows
			.command('validate <file>')
			.description('Validate a workflow package file (use - for stdin)')
			.option('--public', 'apply the stricter text-only public-hosting policy')
	).action(async (path: string, opts: CommonOpts & { public?: boolean }) => {
		const api = client(opts);
		if (opts.public) {
			const result = await api.validatePublication({ document_json: readPackageSource(path) });
			if (opts.json) printJson(result);
			else {
				console.log(
					result.valid ? 'valid public workflow snapshot' : 'invalid public workflow snapshot'
				);
				for (const diagnostic of result.diagnostics)
					console.log(`  ${diagnostic.path || '/'}: ${diagnostic.message}`);
			}
			if (!result.valid) process.exitCode = 1;
			return;
		}
		const result = await api.validateLibrary({ document_json: readPackageSource(path) });
		if (opts.json) printJson(result);
		else console.log(formatValidation(result));
		if (!result.valid) process.exitCode = 1;
	});

	withCommon(
		workflows
			.command('preview <file-or-public-url>')
			.description('Prepare and fully review a destination workflow package plan')
			.option('--choices <file>', 'destination choices JSON file')
			.option('--plan-out <file>', 'atomically save the signed plan for a later install')
	).action(async (path: string, opts: CommonOpts & { choices?: string; planOut?: string }) => {
		const choices = opts.choices
			? readStrictObject<WorkflowPackageChoices>(opts.choices, 'choices file')
			: undefined;
		const apiBase = normalizeUrl(resolveUrl(opts));
		const api = client(opts);
		const source = publicationSource(path, apiBase);
		let remoteSource: { url: string; bytes_sha256: string } | undefined;
		let plan;
		if (source.kind === 'hosted') {
			plan = await api.prepareHostedWorkflowPackage(source.snapshotId, choices);
		} else {
			if (source.kind === 'remote') {
				const fetched = await fetchPublicWorkflowPackage(path);
				remoteSource = {
					url: fetched.sourceUrl,
					bytes_sha256: workflowPackageBytesSha256(fetched.raw)
				};
				plan = await api.prepareWorkflowPackage({ document_json: fetched.raw, choices });
			} else {
				const raw = readPackageSource(path);
				plan = await api.prepareWorkflowPackage({ document_json: raw, choices });
			}
		}
		if (opts.planOut) saveWorkflowPackagePlan(opts.planOut, apiBase, plan, remoteSource);
		if (opts.json) printJson(plan);
		else console.log(formatWorkflowPackageReview(plan));
	});

	withCommon(
		workflows
			.command('install <file-or-public-url>')
			.description('Install one exactly reviewed workflow package plan')
			.option('--choices <file>', 'destination choices JSON file (interactive preparation only)')
			.option('--plan <file>', 'signed plan saved by workflows preview')
			.option('--confirm <plan-digest>', 'exact reviewed plan digest (required outside a TTY)')
	).action(
		async (
			path: string,
			opts: CommonOpts & { choices?: string; plan?: string; confirm?: string }
		) => {
			if (path === '-' && process.stdin.isTTY)
				die('"-" reads the package from stdin, but stdin is a terminal');
			if (!opts.plan && !process.stdin.isTTY)
				die(
					'non-interactive install requires a separate prior preview with --plan-out, then --plan and --confirm'
				);
			if (opts.plan && opts.choices)
				die('--choices cannot be used with --plan; the saved choices are authoritative');
			if (path === '-' && !opts.plan)
				die(
					'stdin package input cannot also provide interactive confirmation; use preview --plan-out first'
				);

			const apiBase = normalizeUrl(resolveUrl(opts));
			const api = client(opts);
			let loadSource: () => Promise<string>;
			let plan;
			let planPath = opts.plan;
			if (planPath) {
				const saved = readWorkflowPackagePlan(planPath);
				if (normalizeUrl(saved.api_base) !== apiBase)
					die(`plan belongs to ${saved.api_base}, not ${apiBase}`);
				plan = saved.plan;
				loadSource = async () => {
					const source = publicationSource(path, apiBase);
					let raw: string;
					if (saved.remote_source) {
						if (source.kind !== 'remote')
							die('saved remote plan must be installed from its public source URL');
						const fetched = await fetchPublicWorkflowPackage(path);
						if (
							fetched.sourceUrl !== saved.remote_source.url ||
							workflowPackageBytesSha256(fetched.raw) !== saved.remote_source.bytes_sha256
						)
							die('public source changed since preview; create and review a fresh plan');
						raw = fetched.raw;
					} else if (saved.plan.source?.kind === 'hosted_publication') {
						if (source.kind !== 'hosted' || source.snapshotId !== saved.plan.source.snapshot_id)
							die('saved hosted plan belongs to a different public snapshot');
						await api.getPublicSnapshotStatus(source.snapshotId);
						raw = canonicalWorkflowPackage(saved.plan.document);
					} else {
						if (source.kind !== 'file') die('saved file plan must be installed from its file');
						raw = readPackageSource(path);
					}
					const { document } = await packageDocument(raw);
					if (
						saved.document_digest !== document.digest ||
						saved.plan.document_digest !== document.digest ||
						canonicalWorkflowPackage(saved.plan.document) !== canonicalWorkflowPackage(document)
					)
						die(
							`package digest ${document.digest} does not match saved plan ${saved.document_digest}`
						);
					return raw;
				};
			} else {
				const source = publicationSource(path, apiBase);
				const choices = opts.choices
					? readStrictObject<WorkflowPackageChoices>(opts.choices, 'choices file')
					: undefined;
				let remoteSource: { url: string; bytes_sha256: string } | undefined;
				let raw: string;
				if (source.kind === 'hosted') {
					plan = await api.prepareHostedWorkflowPackage(source.snapshotId, choices);
					raw = canonicalWorkflowPackage(plan.document);
				} else if (source.kind === 'remote') {
					const fetched = await fetchPublicWorkflowPackage(path);
					raw = fetched.raw;
					await packageDocument(raw);
					remoteSource = {
						url: fetched.sourceUrl,
						bytes_sha256: workflowPackageBytesSha256(raw)
					};
					plan = await api.prepareWorkflowPackage({ document_json: raw, choices });
				} else {
					({ raw } = await localDocument(path));
					plan = await api.prepareWorkflowPackage({ document_json: raw, choices });
				}
				planPath = source.kind === 'file' ? `${path}.plan.json` : 'workflow-publication.plan.json';
				saveWorkflowPackagePlan(planPath, apiBase, plan, remoteSource);
				console.error(`saved retryable signed plan to ${planPath}`);
				loadSource = async () => raw;
			}

			if (opts.confirm !== undefined && opts.confirm !== plan.plan_digest)
				die(`confirmation digest does not match reviewed plan ${plan.plan_digest}`);
			if (!process.stdin.isTTY && opts.confirm !== plan.plan_digest)
				die(`non-interactive install requires --confirm ${plan.plan_digest}`);
			if (process.stdin.isTTY && opts.confirm === undefined) {
				if (!(await askToInstall(plan))) die('installation declined');
			} else {
				process.stderr.write(`${formatWorkflowPackageReview(plan)}\n`);
			}

			const receipt = await recoverOrInstall(api, loadSource, plan);
			if (opts.json) printJson(receipt);
			else {
				console.log(`installed workflow package (${receipt.id})`);
				console.log(`plan: ${receipt.plan_digest}`);
				for (const object of receipt.objects)
					console.log(`  ${object.kind}: ${object.name} — ${object.href}`);
			}
		}
	);
}

function normalizeUrl(value: string): string {
	try {
		return new URL(value).toString().replace(/\/$/, '');
	} catch {
		die(`invalid API base URL: ${value}`);
	}
}
