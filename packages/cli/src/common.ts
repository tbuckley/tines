/**
 * Cross-noun plumbing shared by the command modules: the common flags, the API
 * client, output helpers, and the name→id resolvers. Everything used by two or
 * more `commands/*.ts` modules lives here; single-consumer helpers travel with
 * their noun.
 */
import { formatTable } from './format.js';
import { parseIssueRef } from './refs.js';
import {
	ApiError,
	createApiClient,
	listAll,
	type ApiClient,
	type IssueDetail,
	type ListResponse,
	type PageParams,
	type Project,
	type Runner,
	type WorkflowResponse,
	type WorkflowState
} from '@tines/shared';
import { Option, type Command } from 'commander';
import { loadCliConfig } from './config.js';

export const DEFAULT_URL = 'http://localhost:5173';

export interface CommonOpts {
	/** Absent on commands where --url means something else; falls back to TINES_API_URL. */
	url?: string;
	/** Absent unless --api-key was passed; falls back to TINES_API_KEY. */
	apiKey?: string;
	json?: boolean;
}

export interface ListOpts extends CommonOpts {
	limit?: number;
	cursor?: string;
	allPages?: boolean;
}

/**
 * Adds the options shared by every command (after the subcommand name).
 * `baseUrlFlag: false` skips `-u, --url` for commands where `--url` means
 * something else (`context create/edit` repo pointers); TINES_API_URL still
 * applies there.
 */
export function withCommon(cmd: Command, { baseUrlFlag = true } = {}): Command {
	if (baseUrlFlag) {
		cmd.option(
			'-u, --url <url>',
			`base URL of the Tines API (or set TINES_API_URL, or run \`tines login\`; default ${DEFAULT_URL})`
		);
	}
	return cmd
		.option('--api-key <key>', 'API key (or set TINES_API_KEY, or run `tines login`)')
		.option('--json', 'output the raw JSON response');
}

/**
 * Adds the pagination options shared by every list command. --all-pages walks
 * the cursor for callers (agents, mostly) that want the whole list and would
 * otherwise treat the first page as if it were everything; --limit then sets
 * the page size rather than a total.
 */
export function withList(cmd: Command): Command {
	return withCommon(
		cmd
			.option('--limit <n>', 'maximum items to return (page size under --all-pages)', (v) =>
				Number.parseInt(v, 10)
			)
			.option('--cursor <cursor>', 'resume from the next_cursor of a previous page')
			.addOption(
				new Option(
					'--all-pages',
					'fetch every page, not just the first (slower on large lists)'
				).conflicts('cursor')
			)
	);
}

/** Where a resolved setting came from, in precedence order. */
export type SettingSource = 'flag' | 'env' | 'config' | 'default';

export interface ResolvedSetting {
	value: string | undefined;
	source: SettingSource;
}

/**
 * The env vars are read here rather than declared as commander defaults: an
 * option's default value is rendered into its help text, so defaulting
 * --api-key to TINES_API_KEY printed the caller's live key on every --help.
 *
 * After the flag and the env var comes the file `tines login` writes
 * (config.ts), then the default. `tines config` shows which one won.
 */
export function resolveUrlSetting(opts: CommonOpts): ResolvedSetting {
	if (opts.url) return { value: opts.url, source: 'flag' };
	if (process.env.TINES_API_URL) return { value: process.env.TINES_API_URL, source: 'env' };
	const stored = loadCliConfig().url;
	if (stored) return { value: stored, source: 'config' };
	return { value: DEFAULT_URL, source: 'default' };
}

export function resolveApiKeySetting(opts: CommonOpts): ResolvedSetting {
	if (opts.apiKey) return { value: opts.apiKey, source: 'flag' };
	if (process.env.TINES_API_KEY) return { value: process.env.TINES_API_KEY, source: 'env' };
	const stored = loadCliConfig().api_key;
	if (stored) return { value: stored, source: 'config' };
	return { value: undefined, source: 'default' };
}

export function resolveUrl(opts: CommonOpts): string {
	return resolveUrlSetting(opts).value as string;
}

export function resolveApiKey(opts: CommonOpts): string | undefined {
	return resolveApiKeySetting(opts).value;
}

export function client(opts: CommonOpts): ApiClient {
	return createApiClient({ baseUrl: resolveUrl(opts), apiKey: resolveApiKey(opts) });
}

export function die(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

export function reportError(err: unknown): never {
	if (err instanceof ApiError) {
		let message = `${err.message} (${err.code})`;
		const allowed = err.details?.allowed_transitions;
		if (Array.isArray(allowed)) {
			const actions = allowed.map((t) => {
				const at = t as { name: string; to_state?: { name: string } };
				return at.to_state ? `"${at.name}" → ${at.to_state.name}` : `"${at.name}"`;
			});
			message +=
				actions.length > 0
					? `\nallowed actions: ${actions.join(', ')}`
					: '\nallowed actions: none (terminal state)';
		}
		// A gated transition: print each unmet requirement with the runnable
		// fix command the server includes, so the loop closes without help.
		const unmet = err.details?.unmet;
		if (Array.isArray(unmet)) {
			for (const raw of unmet) {
				const r = raw as {
					artifact: string;
					type?: string;
					content_type?: string;
					status?: string;
					description?: string;
					fix?: string;
				};
				const spec = [r.type, r.content_type].filter(Boolean).join(', ');
				message += `\nrequires artifact "${r.artifact}"${spec ? ` (${spec})` : ''}: ${r.status ?? 'unmet'}${r.description ? ` — ${r.description}` : ''}`;
				if (r.fix) message += `\n  fix: ${r.fix}`;
			}
		}
		die(message);
	}
	die(err instanceof Error ? err.message : String(err));
}

export function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

/**
 * Prints a page: full `{items, next_cursor}` response under --json, else the
 * rendered table plus a hint when another page exists.
 */
export function printList<T>(
	res: ListResponse<T>,
	opts: ListOpts,
	render: (items: T[]) => void
): void {
	if (opts.json) return printJson(res);
	render(res.items);
	if (res.next_cursor) {
		console.log(
			`\nmore results: rerun with --all-pages, or resume with --cursor ${res.next_cursor}`
		);
	}
}

/**
 * Fetches what a list command should print: one page, or — under --all-pages —
 * every page collapsed into the same `{items, next_cursor}` shape so --json
 * output is indistinguishable from a list that happened to fit in one page.
 *
 * Without the flag, a dropped page is announced on stderr under --json (table
 * mode says the same thing on stdout via printList). --json output has to stay
 * parseable, and agents read run logs. Passing --cursor is deliberate paging,
 * so it is not warned about.
 */
export async function fetchList<T extends { id: string }>(
	opts: ListOpts,
	fetchPage: (page: PageParams) => Promise<ListResponse<T>>
): Promise<ListResponse<T>> {
	if (opts.allPages) {
		return { items: await listAll(fetchPage, { pageSize: opts.limit }), next_cursor: null };
	}
	const res = await fetchPage({ limit: opts.limit, cursor: opts.cursor });
	if (res.next_cursor && opts.json && !opts.cursor) {
		console.error(
			'warning: more items exist beyond this page — rerun with --all-pages for all of them'
		);
	}
	return res;
}

export function table(rows: string[][]): void {
	if (rows.length === 0) return;
	console.log(formatTable(rows));
}

// ---------------------------------------------------------------------------
// Reference resolution (names are the human interface; the API wants ids)

export async function resolveProject(api: ApiClient, ref: string): Promise<Project> {
	const { items } = await api.listProjects();
	const byId = items.find((p) => p.id === ref);
	if (byId) return byId;
	const byName = items.filter((p) => p.name === ref);
	if (byName.length === 1) return byName[0];
	if (byName.length > 1) {
		die(`project name "${ref}" is ambiguous; use an id: ${byName.map((p) => p.id).join(', ')}`);
	}
	die(`no project named "${ref}" (have: ${items.map((p) => p.name).join(', ') || 'none'})`);
}

export async function resolveWorkflow(api: ApiClient, ref: string): Promise<WorkflowResponse> {
	const { items } = await api.listWorkflows();
	const found =
		items.find((w) => w.id === ref) ??
		(items.filter((w) => w.name === ref).length === 1
			? items.find((w) => w.name === ref)
			: undefined);
	if (found) return found;
	if (items.filter((w) => w.name === ref).length > 1) {
		die(`workflow name "${ref}" is ambiguous; use an id`);
	}
	die(`no workflow "${ref}" (have: ${items.map((w) => `${w.name} [${w.id}]`).join(', ')})`);
}

export async function resolveIssue(api: ApiClient, ref: string): Promise<IssueDetail> {
	const { project, number } = parseIssueRef(ref);
	const proj = await resolveProject(api, project);
	return api.getIssueByNumber(proj.id, number);
}

/**
 * Resolves `--state <workflow>/<state>` (state names are only unique per
 * workflow, so the qualified form is required everywhere).
 */
export async function resolveStateFlag(
	api: ApiClient,
	ref: string
): Promise<{ workflow: WorkflowResponse; state: WorkflowState }> {
	const sep = ref.indexOf('/');
	if (sep < 1 || sep === ref.length - 1) {
		die(`--state must look like <workflow>/<state>, got "${ref}"`);
	}
	const workflow = await resolveWorkflow(api, ref.slice(0, sep));
	const stateRef = ref.slice(sep + 1);
	const state =
		workflow.states.find((s) => s.name === stateRef) ??
		workflow.states.find((s) => s.id === stateRef);
	if (!state) {
		die(
			`workflow "${workflow.name}" has no state "${stateRef}" (have: ${workflow.states.map((s) => s.name).join(', ')})`
		);
	}
	return { workflow, state };
}

export const collect = (value: string, previous: string[]) => [...previous, value];

export async function resolveRunner(api: ApiClient, ref: string): Promise<Runner> {
	const { items } = await api.listRunners();
	const found = items.find((r) => r.name === ref) ?? items.find((r) => r.id === ref);
	if (!found) {
		die(`no runner named "${ref}" (have: ${items.map((r) => r.name).join(', ') || 'none'})`);
	}
	return found;
}
