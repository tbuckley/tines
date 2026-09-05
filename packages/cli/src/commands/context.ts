/** `tines context` — context items (prompts, skills, repo pointers) and their scopes. */
import { readBodyValue } from '../body-value.js';
import {
	client,
	collect,
	die,
	fetchList,
	printJson,
	printList,
	resolveIssue,
	resolveProject,
	resolveStateFlag,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { contextItemSummary, timestamp } from '../format.js';
import { parseFileSpec } from '../refs.js';
import {
	AGENT_GUIDELINES_BODY,
	AGENT_GUIDELINES_DESCRIPTION,
	AGENT_GUIDELINES_NAME,
	listAll,
	repoDirFromUrl,
	type ApiClient,
	type ContextItem,
	type ContextKind,
	type CreateContextItemRequest,
	type UpdateContextItemRequest
} from '@tines/shared';
import type { Command } from 'commander';

interface ScopeFlagOpts {
	project?: string;
	state?: string;
	issue?: string;
	label?: string;
}

type ScopeIdFields = Pick<
	CreateContextItemRequest,
	'project_id' | 'workflow_state_id' | 'issue_id' | 'label_id'
>;

/** Resolves a label by name (case-insensitive) or id against the library. */
async function resolveLabelFlag(api: ApiClient, ref: string): Promise<string> {
	const match = (await api.listLabels()).items.find(
		(l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase()
	);
	if (!match) die(`no such label: ${ref}`);
	return match.id;
}

/** Resolves the scope flags (names → ids). Only set flags are returned. */
async function resolveScopeFlags(api: ApiClient, opts: ScopeFlagOpts): Promise<ScopeIdFields> {
	const scope: ScopeIdFields = {};
	if (opts.project !== undefined) scope.project_id = (await resolveProject(api, opts.project)).id;
	if (opts.state !== undefined)
		scope.workflow_state_id = (await resolveStateFlag(api, opts.state)).state.id;
	if (opts.issue !== undefined) scope.issue_id = (await resolveIssue(api, opts.issue)).id;
	if (opts.label !== undefined) scope.label_id = await resolveLabelFlag(api, opts.label);
	return scope;
}

function printContextItem(item: ContextItem): void {
	console.log(`${item.kind} "${item.name}"  [${item.id}]  v${item.version}`);
	if (item.description) console.log(item.description);
	console.log(`scope: ${item.scope.label}`);
	console.log(`updated: ${timestamp(item.updated_at)}  created: ${timestamp(item.created_at)}`);
	if (item.kind === 'artifact') {
		console.log(`\ntype: ${item.artifact_type ?? 'artifact'}`);
		if (item.scope.issue_ref) {
			const ref = `${item.scope.issue_ref.project_name}/${item.scope.issue_ref.number}`;
			console.log(`versions and content: tines issues artifacts show ${ref} ${item.name}`);
		}
	} else if (item.kind === 'prompt') {
		console.log(`\n${item.body}`);
	} else if (item.kind === 'skill') {
		console.log(`\nfiles (seeded at skills/${item.name}/):`);
		for (const f of item.files ?? []) {
			console.log(`  ${f.path}  (${Buffer.byteLength(f.content, 'utf8')} bytes)`);
		}
		if ((item.files ?? []).length === 0) console.log('  (none)');
	} else {
		console.log(`\nurl: ${item.repo_url}`);
		if (item.repo_branch) console.log(`branch: ${item.repo_branch}`);
		console.log(
			`dir: ${item.repo_dir ?? `${repoDirFromUrl(item.repo_url ?? '')} (derived from the URL)`}`
		);
	}
}

const SCOPE_FLAGS_HELP = `
Scope flags (combinable — an item applies where ALL of its set dimensions match):
  --project <name>              only for issues in this project
  --state <workflow>/<state>    only for issues currently in this state
  --issue <project>/<number>    only for this issue
  --label <name>                only for issues carrying this label
`;

function withScopeFlags(cmd: Command): Command {
	return cmd
		.option('-p, --project <name>', 'scope: project name or id')
		.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
		.option('-i, --issue <ref>', 'scope: issue (<project>/<number>)')
		.option('-l, --label <name>', 'scope: issue label name or id')
		.addHelpText('after', SCOPE_FLAGS_HELP);
}

export function register(program: Command): void {
	const context = program
		.command('context')
		.description(
			'Manage context items (prompts, skills, repo pointers) scoped to projects, states, and issues'
		);

	withList(
		withScopeFlags(
			context
				.command('list')
				.description(
					'List context items (scope filters match every item whose scope includes the element)'
				)
				.option('-k, --kind <kind>', 'filter by kind: prompt, skill, or repo')
				.option('--exact', 'only items whose scope sets exactly the given dimensions')
				.option('-q, --search <text>', 'search names and descriptions')
		)
	).action(
		async (
			opts: ListOpts & ScopeFlagOpts & { kind?: ContextKind; exact?: boolean; search?: string }
		) => {
			const api = client(opts);
			const scope = await resolveScopeFlags(api, opts);
			const res = await fetchList(opts, (page) =>
				api.listContext({
					kind: opts.kind,
					project: scope.project_id ?? undefined,
					state: scope.workflow_state_id ?? undefined,
					issue: scope.issue_id ?? undefined,
					label: scope.label_id ?? undefined,
					q: opts.search,
					exact: opts.exact ? true : undefined,
					...page
				})
			);
			printList(res, opts, (items) => {
				if (items.length === 0) return console.log('no context items');
				table([
					['KIND', 'NAME', 'SCOPE', 'PAYLOAD', 'UPDATED', 'ID'],
					...items.map((i) => [
						i.kind,
						i.name,
						i.scope.label,
						contextItemSummary(i),
						timestamp(i.updated_at),
						i.id
					])
				]);
			});
		}
	);

	withCommon(
		context.command('show <id>').description('Show a context item (skills include their files)')
	).action(async (id: string, opts: CommonOpts) => {
		const item = await client(opts).getContextItem(id);
		if (opts.json) return printJson(item);
		printContextItem(item);
	});

	withCommon(
		withScopeFlags(
			context
				.command('create')
				.description('Create a context item scoped to a project, state, and/or issue')
				.requiredOption('-k, --kind <kind>', 'prompt, skill, or repo')
				.requiredOption(
					'-n, --name <name>',
					'item name (slug-like for skills; the dedup/override key)'
				)
				.option('-d, --description <text>', 'one-liner shown in lists')
				.option('--body <md>', 'prompt body: inline Markdown or @file (escape a literal @ as @@)')
				.option(
					'--file <path>=@<local>',
					'skill file: workspace path = local file (repeatable)',
					collect,
					[]
				)
				.option('--repo-url <url>', 'repo: clone URL')
				.option('--branch <branch>', 'repo: branch to check out')
				.option('--dir <dir>', "repo: checkout directory (defaults to the URL's basename)")
		)
	).action(
		async (
			opts: CommonOpts &
				ScopeFlagOpts & {
					kind: string;
					name: string;
					description?: string;
					body?: string;
					file: string[];
					repoUrl?: string;
					branch?: string;
					dir?: string;
				}
		) => {
			if (opts.kind === 'repo' && opts.repoUrl === undefined) {
				die('--kind repo needs --repo-url <clone-url> (--url is the API base URL)');
			}
			const api = client(opts);
			const scope = await resolveScopeFlags(api, opts);
			const body: CreateContextItemRequest = {
				kind: opts.kind as ContextKind,
				name: opts.name,
				description: opts.description,
				...scope
			};
			if (opts.body !== undefined) body.body = readBodyValue(opts.body);
			if (opts.file.length > 0) body.files = opts.file.map(parseFileSpec);
			if (opts.kind === 'skill' && body.files === undefined) body.files = [];
			if (opts.repoUrl !== undefined) body.repo_url = opts.repoUrl;
			if (opts.branch !== undefined) body.repo_branch = opts.branch;
			if (opts.dir !== undefined) body.repo_dir = opts.dir;
			const item = await api.createContextItem(body);
			if (opts.json) return printJson(item);
			console.log(`created ${item.kind} "${item.name}" (${item.id}) — scope: ${item.scope.label}`);
		}
	);

	withCommon(
		withScopeFlags(
			context
				.command('edit <id>')
				.description('Edit a context item: payload, name, description, or scope')
				.option('-n, --name <name>', 'rename the item')
				.option('-d, --description <text>', 'set the description')
				.option('--body <md>', 'prompt body: inline Markdown or @file (escape a literal @ as @@)')
				.option('--file <path>=@<local>', 'add or replace a skill file (repeatable)', collect, [])
				.option('--remove-file <path>', 'remove a skill file (repeatable)', collect, [])
				.option('--repo-url <url>', 'repo: clone URL')
				.option('--branch <branch>', 'repo: branch (empty string clears it)')
				.option('--dir <dir>', 'repo: checkout directory (empty string restores the URL default)')
				.option(
					'--unset <dimension>',
					'drop a scope dimension: project, state, issue, or label (repeatable)',
					collect,
					[]
				)
				.option(
					'--expect-version <n>',
					'fail (409) unless the item is still at this version',
					(v) => Number.parseInt(v, 10)
				)
		)
	).action(
		async (
			id: string,
			opts: CommonOpts &
				ScopeFlagOpts & {
					name?: string;
					description?: string;
					body?: string;
					file: string[];
					removeFile: string[];
					repoUrl?: string;
					branch?: string;
					dir?: string;
					unset: string[];
					expectVersion?: number;
				}
		) => {
			const api = client(opts);
			const body: UpdateContextItemRequest = {};
			if (opts.expectVersion !== undefined) body.expected_version = opts.expectVersion;
			if (opts.name !== undefined) body.name = opts.name;
			if (opts.description !== undefined) body.description = opts.description;
			const scope = await resolveScopeFlags(api, opts);
			Object.assign(body, scope);
			for (const dim of opts.unset) {
				if (dim === 'project') body.project_id = null;
				else if (dim === 'state') body.workflow_state_id = null;
				else if (dim === 'issue') body.issue_id = null;
				else if (dim === 'label') body.label_id = null;
				else die(`--unset takes project, state, issue, or label, got "${dim}"`);
			}
			if (opts.body !== undefined) body.body = readBodyValue(opts.body);
			if (opts.file.length > 0 || opts.removeFile.length > 0) {
				// Skill files PATCH declaratively: fetch, apply the edits, send the
				// full list. --file replaces an existing path or adds a new one.
				const current = await api.getContextItem(id);
				if (current.kind !== 'skill')
					die(`--file/--remove-file only apply to skills (this is a ${current.kind})`);
				// The full-list PATCH is built from the files just read, so pin the
				// write to that read: a concurrent file edit becomes a 409 instead
				// of being silently replaced by this stale list.
				if (body.expected_version === undefined) body.expected_version = current.version;
				const files = new Map((current.files ?? []).map((f) => [f.path, f.content]));
				for (const path of opts.removeFile) {
					if (!files.delete(path)) {
						die(
							`no file "${path}" in skill "${current.name}" (have: ${[...files.keys()].join(', ') || 'none'})`
						);
					}
				}
				for (const spec of opts.file) {
					const f = parseFileSpec(spec);
					files.set(f.path, f.content);
				}
				body.files = [...files.entries()].map(([path, content]) => ({ path, content }));
			}
			if (opts.repoUrl !== undefined) body.repo_url = opts.repoUrl;
			if (opts.branch !== undefined) body.repo_branch = opts.branch === '' ? null : opts.branch;
			if (opts.dir !== undefined) body.repo_dir = opts.dir === '' ? null : opts.dir;
			if (Object.keys(body).length === 0) {
				die(
					'nothing to update: pass payload flags, --name/--description, scope flags, and/or --unset'
				);
			}
			const item = await api.updateContextItem(id, body);
			if (opts.json) return printJson(item);
			console.log(`updated ${item.kind} "${item.name}" (${item.id}) — scope: ${item.scope.label}`);
		}
	);

	withCommon(context.command('delete <id>').description('Delete a context item')).action(
		async (id: string, opts: CommonOpts) => {
			const api = client(opts);
			const item = await api.getContextItem(id);
			await api.deleteContextItem(id);
			console.log(`deleted ${item.kind} "${item.name}" (${item.id}) — scope: ${item.scope.label}`);
		}
	);

	withCommon(
		context
			.command('init')
			.description('Seed the global "agent-guidelines" prompt (a no-op if it already exists)')
	).action(async (opts: CommonOpts) => {
		const api = client(opts);
		// Global items only: exact=true with no dimension filters.
		const items = await listAll((page) =>
			api.listContext({ kind: 'prompt', exact: true, ...page })
		);
		const existing = items.find((i) => i.name === AGENT_GUIDELINES_NAME);
		if (existing) {
			if (opts.json) return printJson(existing);
			return console.log(
				`"${AGENT_GUIDELINES_NAME}" already exists (${existing.id}, v${existing.version}) — left untouched`
			);
		}
		const created = await api.createContextItem({
			kind: 'prompt',
			name: AGENT_GUIDELINES_NAME,
			description: AGENT_GUIDELINES_DESCRIPTION,
			body: AGENT_GUIDELINES_BODY
		});
		if (opts.json) return printJson(created);
		console.log(
			`seeded global "${AGENT_GUIDELINES_NAME}" (${created.id}) — it now opens every launch prompt; edit it freely`
		);
	});
}
