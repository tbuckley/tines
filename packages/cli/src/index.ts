import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runDaemon } from './daemon/daemon.js';
import { defaultConfigDir, hasRunnerCredentials, saveRunnerCredentials } from './daemon/store.js';
import { HARNESS_KINDS, type HarnessKind } from './daemon/support.js';
import { helpGuard } from './help-guard.js';
import {
	actorLabel,
	AGENT_GUIDELINES_BODY,
	AGENT_GUIDELINES_DESCRIPTION,
	AGENT_GUIDELINES_NAME,
	ApiError,
	createApiClient,
	parsePrSpec,
	describeRecurrence,
	isStaleTierOverride,
	JOURNAL_NAME,
	MODEL_TIERS,
	repoDirFromUrl,
	runDurationLabel,
	utilizationLabel,
	WEEKDAY_NAMES,
	type AgentRun,
	type ApiClient,
	type Artifact,
	type ArtifactVersion,
	type ContextFile,
	type ContextItem,
	type ContextKind,
	type CreateContextItemRequest,
	type CreateScheduleInput,
	type CreateWorkflowRequest,
	type DispatchExplainer,
	type IssueDetail,
	type IssueLinks,
	type LinkedIssue,
	type ListResponse,
	type ModelTier,
	type Project,
	type QuotaPolicy,
	type RoutingRule,
	type Runner,
	type Schedule,
	type SchedulePreset,
	type StateCategory,
	type TinesEvent,
	type UpdateContextItemRequest,
	type UpdateIssueRequest,
	type UpdateRunnerRequest,
	type UpdateProjectRequest,
	type UpdateScheduleRequest,
	type UpdateWorkflowRequest,
	type WorkflowResponse,
	type WorkflowState
} from '@tines/shared';
import { Command } from 'commander';

const DEFAULT_URL = 'http://localhost:5173';

interface CommonOpts {
	/** Absent on commands where --url means something else; falls back to TINES_API_URL. */
	url?: string;
	/** Absent unless --api-key was passed; falls back to TINES_API_KEY. */
	apiKey?: string;
	json?: boolean;
}

interface ListOpts extends CommonOpts {
	limit?: number;
	cursor?: string;
}

/**
 * Adds the options shared by every command (after the subcommand name).
 * `baseUrlFlag: false` skips `-u, --url` for commands where `--url` means
 * something else (`context create/edit` repo pointers); TINES_API_URL still
 * applies there.
 */
function withCommon(cmd: Command, { baseUrlFlag = true } = {}): Command {
	if (baseUrlFlag) {
		cmd.option(
			'-u, --url <url>',
			`base URL of the Tines API (or set TINES_API_URL; default ${DEFAULT_URL})`
		);
	}
	return cmd
		.option('--api-key <key>', 'API key (or set TINES_API_KEY)')
		.option('--json', 'output the raw JSON response');
}

/** Adds the pagination options shared by every list command. */
function withList(cmd: Command): Command {
	return withCommon(
		cmd
			.option('--limit <n>', 'maximum items to return', (v) => Number.parseInt(v, 10))
			.option('--cursor <cursor>', 'resume from the next_cursor of a previous page')
	);
}

/**
 * The env vars are read here rather than declared as commander defaults: an
 * option's default value is rendered into its help text, so defaulting
 * --api-key to TINES_API_KEY printed the caller's live key on every --help.
 */
function resolveUrl(opts: CommonOpts): string {
	return opts.url ?? process.env.TINES_API_URL ?? DEFAULT_URL;
}

function resolveApiKey(opts: CommonOpts): string | undefined {
	return opts.apiKey ?? process.env.TINES_API_KEY;
}

function client(opts: CommonOpts): ApiClient {
	return createApiClient({ baseUrl: resolveUrl(opts), apiKey: resolveApiKey(opts) });
}

function die(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

function reportError(err: unknown): never {
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

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
}

/**
 * Prints a page: full `{items, next_cursor}` response under --json, else the
 * rendered table plus a hint when another page exists.
 */
function printList<T>(res: ListResponse<T>, opts: ListOpts, render: (items: T[]) => void): void {
	if (opts.json) return printJson(res);
	render(res.items);
	if (res.next_cursor) console.log(`\nmore results: rerun with --cursor ${res.next_cursor}`);
}

function table(rows: string[][]): void {
	if (rows.length === 0) return;
	const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
	for (const row of rows) {
		console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
	}
}

function timestamp(ms: number): string {
	return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// JSON body input (inline argument, --file <path>, --file -, or piped stdin)

function parseJsonObject(raw: string, source: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		die(`invalid JSON from ${source}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		die(`expected a JSON object from ${source}`);
	}
	return value as Record<string, unknown>;
}

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

/**
 * The creation nudge for workflow states: every NEW state (no "id") should
 * carry a "prompt" key — its initial stage instructions — unless the caller
 * declines with --no-prompts.
 */
function assertNewStatesHavePrompts(states: unknown, prompts: boolean | undefined): void {
	if (prompts === false || !Array.isArray(states)) return;
	const missing = states
		.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
		.filter((s) => s.id === undefined && !String(s.prompt ?? '').trim())
		.map((s) => (typeof s.name === 'string' ? s.name : '?'));
	if (missing.length > 0) {
		die(
			`new state${missing.length === 1 ? '' : 's'} ${missing.map((n) => `"${n}"`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no initial prompt — issues sitting in a state inherit its context\n` +
				'  add "prompt": "<markdown>" to each new state in the JSON (its stage instructions), or pass --no-prompts to skip'
		);
	}
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

// ---------------------------------------------------------------------------
// Reference resolution (names are the human interface; the API wants ids)

async function resolveProject(api: ApiClient, ref: string): Promise<Project> {
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

async function resolveWorkflow(api: ApiClient, ref: string): Promise<WorkflowResponse> {
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

function parseScheduleRef(ref: string): { project: string; name: string } {
	const sep = ref.indexOf('/');
	if (sep < 1 || sep === ref.length - 1) {
		die(`schedule reference must look like <project>/<name>, got "${ref}"`);
	}
	return { project: ref.slice(0, sep), name: ref.slice(sep + 1) };
}

async function resolveSchedule(api: ApiClient, ref: string): Promise<Schedule> {
	const { project, name } = parseScheduleRef(ref);
	const proj = await resolveProject(api, project);
	const { items } = await api.listProjectSchedules(proj.id, { limit: 100 });
	const found = items.find((s) => s.name === name) ?? items.find((s) => s.id === name);
	if (!found) {
		die(
			`no schedule "${name}" in project "${proj.name}" (have: ${items.map((s) => s.name).join(', ') || 'none'})`
		);
	}
	return found;
}

function parseIssueRef(ref: string): { project: string; number: number } {
	const match = ref.match(/^(.+)\/(\d+)$/);
	if (!match) die(`issue reference must look like <project>/<number>, got "${ref}"`);
	return { project: match[1], number: Number.parseInt(match[2], 10) };
}

async function resolveIssue(api: ApiClient, ref: string): Promise<IssueDetail> {
	const { project, number } = parseIssueRef(ref);
	const proj = await resolveProject(api, project);
	return api.getIssueByNumber(proj.id, number);
}

/**
 * Resolves `--state <workflow>/<state>` (state names are only unique per
 * workflow, so the qualified form is required everywhere).
 */
async function resolveStateFlag(
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
		workflow.states.find((s) => s.name === stateRef) ?? workflow.states.find((s) => s.id === stateRef);
	if (!state) {
		die(
			`workflow "${workflow.name}" has no state "${stateRef}" (have: ${workflow.states.map((s) => s.name).join(', ')})`
		);
	}
	return { workflow, state };
}

// ---------------------------------------------------------------------------
// Context items

interface ScopeFlagOpts {
	project?: string;
	state?: string;
	issue?: string;
}

/** Resolves the scope flags (names → ids). Only set flags are returned. */
async function resolveScopeFlags(
	api: ApiClient,
	opts: ScopeFlagOpts
): Promise<Pick<CreateContextItemRequest, 'project_id' | 'workflow_state_id' | 'issue_id'>> {
	const scope: Pick<CreateContextItemRequest, 'project_id' | 'workflow_state_id' | 'issue_id'> = {};
	if (opts.project !== undefined) scope.project_id = (await resolveProject(api, opts.project)).id;
	if (opts.state !== undefined) scope.workflow_state_id = (await resolveStateFlag(api, opts.state)).state.id;
	if (opts.issue !== undefined) scope.issue_id = (await resolveIssue(api, opts.issue)).id;
	return scope;
}

/** `--body` takes inline Markdown or `@file`; a literal `@…` escapes as `@@…`. */
function readBodyValue(value: string): string {
	if (value.startsWith('@@')) return value.slice(1);
	if (value.startsWith('@')) {
		const file = value.slice(1);
		try {
			return readFileSync(file, 'utf8');
		} catch (err) {
			die(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return value;
}

/**
 * `--file <path>=@<local>`: maps a workspace path to a local file's content.
 * Workspace paths cannot contain `=`, so the first `=` is the separator;
 * content always comes from a file (no inline form).
 */
function parseFileSpec(spec: string): ContextFile {
	const sep = spec.indexOf('=');
	if (sep < 1 || sep === spec.length - 1) {
		die(`--file must look like <path>=@<local-file>, got "${spec}"`);
	}
	const path = spec.slice(0, sep);
	const source = spec.slice(sep + 1);
	if (!source.startsWith('@')) {
		die(`skill file content always comes from a local file: --file ${path}=@<local-file>`);
	}
	const file = source.slice(1);
	try {
		return { path, content: readFileSync(file, 'utf8') };
	} catch (err) {
		die(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

const collect = (value: string, previous: string[]) => [...previous, value];

function contextItemSummary(item: ContextItem): string {
	switch (item.kind) {
		case 'prompt':
			return `${Buffer.byteLength(item.body ?? '', 'utf8')} bytes`;
		case 'skill':
			return `${item.file_count ?? item.files?.length ?? 0} file${(item.file_count ?? item.files?.length ?? 0) === 1 ? '' : 's'}`;
		case 'repo':
			return `${item.repo_url}${item.repo_branch ? `#${item.repo_branch}` : ''}`;
		case 'artifact':
			return item.artifact_type ?? 'artifact';
	}
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
		console.log(`dir: ${item.repo_dir ?? `${repoDirFromUrl(item.repo_url ?? '')} (derived from the URL)`}`);
	}
}

// ---------------------------------------------------------------------------
// Recurrence flags (--every/--at/--on build a preset; --cron is the raw form)

interface RecurrenceOpts {
	every?: string;
	at?: string;
	on?: string;
	cron?: string;
	tz?: string;
}

const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function parseWeekday(value: string): number {
	const trimmed = value.trim().toLowerCase();
	if (/^\d+$/.test(trimmed)) {
		const n = Number.parseInt(trimmed, 10);
		if (n <= 7) return n % 7; // 0 and 7 both mean Sunday, as in cron
		die(`--on weekday must be 0-7 or a name, got "${value}"`);
	}
	if (trimmed.length >= 3) {
		const idx = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase().startsWith(trimmed));
		if (idx !== -1) return idx;
	}
	die(`unknown weekday "${value}" (use e.g. monday, tue, or 0-6 with 0 = Sunday)`);
}

/** The preset/cron half of a schedule input, or undefined when no flags given. */
function buildRecurrence(opts: RecurrenceOpts): Pick<CreateScheduleInput, 'preset' | 'cron'> | undefined {
	const hasPresetFlags = opts.every !== undefined || opts.at !== undefined || opts.on !== undefined;
	if (opts.cron !== undefined && hasPresetFlags) {
		die('pass --cron or --every/--at/--on, not both');
	}
	if (opts.cron !== undefined) return { cron: opts.cron };
	if (!hasPresetFlags) return undefined;
	if (opts.every === undefined) {
		die('--at/--on set a preset time; add --every <hourly|Nh|daily|weekly|monthly>');
	}
	const hourly = opts.every === 'hourly' ? 1 : opts.every.match(/^(\d+)h$/)?.[1];
	if (hourly !== undefined) {
		if (opts.on !== undefined) die('an hourly recurrence does not take --on');
		const every = typeof hourly === 'number' ? hourly : Number.parseInt(hourly, 10);
		if (every < 1 || every > 23) die(`--every <N>h needs N between 1 and 23, got "${opts.every}"`);
		// For hourly, --at is the minute past the hour (":15" or "15").
		let minute = 0;
		if (opts.at !== undefined) {
			const m = opts.at.match(/^:?(\d{1,2})$/);
			if (!m || Number.parseInt(m[1], 10) > 59) {
				die(`with an hourly recurrence, --at is the minute past the hour (0-59 or :MM), got "${opts.at}"`);
			}
			minute = Number.parseInt(m[1], 10);
		}
		return { preset: { kind: 'hourly', every_hours: every, minute } };
	}
	const time = opts.at ?? '09:00';
	switch (opts.every) {
		case 'daily': {
			if (opts.on !== undefined) die('--every daily does not take --on');
			return { preset: { kind: 'daily', time } };
		}
		case 'weekly': {
			if (opts.on === undefined) die('--every weekly needs --on <weekday>');
			return { preset: { kind: 'weekly', time, weekday: parseWeekday(opts.on) } };
		}
		case 'monthly': {
			if (opts.on === undefined) die('--every monthly needs --on <day-of-month>');
			const day = Number.parseInt(opts.on, 10);
			if (!/^\d+$/.test(opts.on.trim()) || day < 1 || day > 31) {
				die(`--on day-of-month must be 1-31, got "${opts.on}"`);
			}
			return { preset: { kind: 'monthly', time, day_of_month: day } };
		}
		default:
			die(`--every must be hourly, <N>h, daily, weekly, or monthly, got "${opts.every}"`);
	}
}

function recurrenceLabel(schedule: Schedule): string {
	return `${describeRecurrence(schedule.preset, schedule.cron)}, ${schedule.timezone}`;
}

// ---------------------------------------------------------------------------
// Output helpers

function issueRef(ref: { project_name: string; number: number }): string {
	return `${ref.project_name}/${ref.number}`;
}

/** One table row per linked issue: ref, title, effective state, optional note. */
function linkRows(entries: LinkedIssue[], note: (e: LinkedIssue) => string = () => ''): string[][] {
	return entries.map((e) => [
		`  ${issueRef(e)}`,
		e.title,
		`${e.effective_state.name} (${e.effective_state.category})`,
		note(e)
	]);
}

/** The link sections of `issues show`; empty groups are omitted entirely. */
function printIssueLinks(links: IssueLinks): void {
	if (links.blocked_by.length > 0) {
		console.log('\nblocked by:');
		// Open blockers are exactly why the issue isn't ready, so call them out.
		table(linkRows(links.blocked_by, (e) => (e.effective_state.category === 'done' ? '' : '(open)')));
	}
	if (links.blocks.length > 0) {
		console.log('\nblocks:');
		table(linkRows(links.blocks));
	}
	if (links.duplicate_of) {
		console.log('\nduplicate of:');
		table(linkRows([links.duplicate_of], () => '(the state shown above follows it)'));
	}
	if (links.duplicated_by.length > 0) {
		console.log('\nduplicates:');
		table(linkRows(links.duplicated_by));
	}
}

function printIssueDetail(issue: IssueDetail): void {
	console.log(`${issue.project_name}/#${issue.number}  ${issue.title}`);
	// The state line carries the effective state; on a duplicate that is the
	// canonical issue's, and the issue's own (dormant) state moves below it.
	const dup = issue.duplicate_of;
	console.log(
		`state: ${issue.effective_state.name} (${issue.effective_state.category})${dup ? ` (via ${issueRef(dup)} — duplicate)` : ''}  workflow: ${issue.workflow.name}  updated: ${timestamp(issue.updated_at)}`
	);
	if (dup) {
		console.log(`own state: ${issue.state.name} (${issue.state.category}) — dormant while this is a duplicate`);
	}
	console.log(`id: ${issue.id}`);
	printIssueLinks(issue.links);
	if (issue.description) {
		console.log(`\n${issue.description}`);
	}
	const allowed = issue.allowed_transitions.map((t) => `"${t.name}" → ${t.to_state.name}`);
	console.log(`\nallowed actions: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`);
	if (issue.comments.length > 0) {
		console.log(`\ncomments (${issue.comments.length}):`);
		for (const c of issue.comments) {
			console.log(`\n  [${timestamp(c.created_at)}] ${actorLabel(c.actor)}:`);
			for (const line of c.body.split('\n')) console.log(`  ${line}`);
		}
	}
}

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

function eventSummary(ev: TinesEvent): string {
	const p = ev.payload as Record<string, unknown>;
	const issue = ev.issue_ref ? `${ev.issue_ref.project_name}/#${ev.issue_ref.number}` : null;
	switch (ev.type) {
		case 'issue.created':
			return `created ${issue}: ${p.title}${p.scheduled_task_name ? ` (via schedule "${p.scheduled_task_name}")` : ''}`;
		case 'issue.updated':
			return `updated ${issue} (${(p.changed as string[])?.join(', ')})`;
		case 'issue.transitioned':
			return `${p.action ? `"${p.action}" on` : 'moved'} ${issue}: ${p.from_state_name} → ${p.to_state_name}`;
		case 'issue.commented':
			return `commented on ${issue}`;
		case 'project.created':
		case 'project.updated':
		case 'project.deleted':
			return `${ev.type.split('.')[1]} project "${p.name ?? ev.project_name}"`;
		case 'workflow.created':
		case 'workflow.updated':
		case 'workflow.deleted':
			return `${ev.type.split('.')[1]} workflow "${p.name}"`;
		case 'api_key.created':
			return `created API key "${p.name}"`;
		case 'api_key.revoked':
			return `revoked API key "${p.name}"`;
		case 'scheduled_task.created':
		case 'scheduled_task.updated':
		case 'scheduled_task.deleted':
			return `${ev.type.split('.')[1]} schedule "${p.name}"`;
		case 'context.created':
		case 'context.updated':
		case 'context.deleted': {
			const scope = p.scope as { label?: string } | undefined;
			const verb = ev.type.split('.')[1];
			return `${verb} ${p.kind} "${p.name}"${scope?.label ? ` [${scope.label}]` : ''}`;
		}
		case 'scheduled_task.skipped': {
			const blocking = Array.isArray(p.blocking) ? p.blocking.length : 0;
			return `skipped schedule "${p.name}" (${blocking} open instance${blocking === 1 ? '' : 's'})`;
		}
		case 'runner.registered':
		case 'runner.updated':
		case 'runner.removed':
			return `${ev.type.split('.')[1]} runner "${p.name}"`;
		case 'runner.errored':
			return `runner "${p.runner_name}" failed to launch (${p.consecutive_failures} consecutive): ${p.error}`;
		case 'agent_run.started':
			return `run started on ${issue} via ${p.runner_name} (${p.tier}${p.model ? ` → ${p.model}` : ''})`;
		case 'agent_run.ended':
			return `run ${p.status} on ${issue} via ${p.runner_name}${p.outcome ? ` — ${p.outcome}` : ''}`;
		case 'issue.parked':
			return `parked ${issue} after ${p.attempt_count} strikes — needs attention`;
		case 'issue.resumed':
			return `resumed ${issue} (attempt count reset)`;
		case 'routing_rule.created':
		case 'routing_rule.updated':
		case 'routing_rule.deleted':
			return `${ev.type.split('.')[1]} the ${p.scope_label} routing rule`;
		case 'settings.updated':
			return `updated supervisor settings (${(p.changed as string[])?.join(', ') || 'no changes'})`;
		default:
			return ev.type;
	}
}

// ---------------------------------------------------------------------------
// Program

const program = new Command();
// Positional options let markdown-taking commands (comment, journal append)
// accept bodies that start with "-" — e.g. the dated bullets the launch
// prompt teaches — via passThroughOptions().
program.name('tines').description('CLI for Tines').version('0.0.1').enablePositionalOptions();

withCommon(program.command('time').description('Fetch the current time from the Tines API')).action(
	async (opts: CommonOpts) => {
		const result = await client(opts).getTime();
		if (opts.json) printJson(result);
		else console.log(`Server time: ${result.time} (unix ${result.unix})`);
	}
);

// --- projects ---------------------------------------------------------------

const projects = program.command('projects').description('Manage projects');

withList(projects.command('list').description('List projects')).action(async (opts: ListOpts) => {
	const res = await client(opts).listProjects({ limit: opts.limit, cursor: opts.cursor });
	printList(res, opts, (items) => {
		if (items.length === 0) return console.log('no projects');
		table([
			['NAME', 'ISSUES', 'ID', 'CREATED'],
			...items.map((p) => [p.name, String(p.issue_count), p.id, timestamp(p.created_at)])
		]);
	});
});

withCommon(
	projects
		.command('create <name>')
		.description('Create a project (with its initial context prompt)')
		.option('-d, --description <text>', 'project description')
		.option('-w, --default-workflow <id-or-name>', 'default workflow for new issues')
		.option('--prompt <md>', 'initial conventions prompt, stitched into every issue\'s agent prompt: inline Markdown or @file')
		.option('--no-prompt', 'create without an initial prompt')
).action(
	async (
		name: string,
		opts: CommonOpts & { description?: string; defaultWorkflow?: string; prompt?: string | boolean }
	) => {
		// Every issue in a project inherits its context, so the CLI insists on
		// an explicit choice; the UI's optional textarea is nudge enough there.
		if (opts.prompt === undefined || opts.prompt === true) {
			die(
				'every issue in a project inherits its context — give the project an initial prompt:\n' +
					'  --prompt "<markdown>"   house conventions, inline or @file\n' +
					'  --no-prompt             create without one (add later: tines context create -k prompt -n conventions -p <name> --body …)'
			);
		}
		const api = client(opts);
		const workflowId = opts.defaultWorkflow
			? (await resolveWorkflow(api, opts.defaultWorkflow)).id
			: undefined;
		const project = await api.createProject({
			name,
			description: opts.description,
			default_workflow_id: workflowId,
			initial_prompt: typeof opts.prompt === 'string' ? readBodyValue(opts.prompt) : undefined
		});
		if (opts.json) return printJson(project);
		console.log(
			`created project "${project.name}" (${project.id})${typeof opts.prompt === 'string' ? ' with its "conventions" prompt' : ''}`
		);
	}
);

withCommon(projects.command('show <id-or-name>').description('Show a project')).action(
	async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await resolveProject(api, ref);
		if (opts.json) return printJson(project);
		console.log(`${project.name}  [${project.id}]`);
		if (project.description) console.log(project.description);
		const defaultWorkflow = project.default_workflow_id
			? (await api.getWorkflow(project.default_workflow_id)).name
			: '(standard)';
		console.log(`\ndefault workflow: ${defaultWorkflow}`);
		console.log(
			`issues: ${project.issue_count}  created: ${timestamp(project.created_at)}  updated: ${timestamp(project.updated_at)}`
		);
	}
);

withCommon(
	projects
		.command('edit <id-or-name>')
		.description('Edit a project')
		.option('-n, --name <name>', 'rename the project')
		.option('-d, --description <text>', 'set the description')
		.option('-w, --default-workflow <id-or-name>', 'set the default workflow for new issues')
		.option('--no-default-workflow', 'clear the default workflow (fall back to standard)')
).action(
	async (
		ref: string,
		opts: CommonOpts & { name?: string; description?: string; defaultWorkflow?: string | false }
	) => {
		const api = client(opts);
		const project = await resolveProject(api, ref);
		const body: UpdateProjectRequest = {};
		if (opts.name !== undefined) body.name = opts.name;
		if (opts.description !== undefined) body.description = opts.description;
		if (opts.defaultWorkflow === false) body.default_workflow_id = null;
		else if (opts.defaultWorkflow !== undefined) {
			body.default_workflow_id = (await resolveWorkflow(api, opts.defaultWorkflow)).id;
		}
		if (Object.keys(body).length === 0) {
			die('nothing to update: pass --name, --description, or --[no-]default-workflow');
		}
		const updated = await api.updateProject(project.id, body);
		if (opts.json) return printJson(updated);
		console.log(`updated project "${updated.name}" (${updated.id})`);
	}
);

withCommon(
	projects
		.command('delete <id-or-name>')
		.description('Delete a project (refused while it still contains issues)')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const project = await resolveProject(api, ref);
	await api.deleteProject(project.id);
	console.log(`deleted project "${project.name}" (${project.id})`);
});

// --- workflows ---------------------------------------------------------------

const workflows = program.command('workflows').description('Manage the workflow library');

withList(workflows.command('list').description('List the workflow library')).action(
	async (opts: ListOpts) => {
		const res = await client(opts).listWorkflows({ limit: opts.limit, cursor: opts.cursor });
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
	workflows.command('show <id-or-name>').description('Show a workflow with states and transitions')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const wf = await resolveWorkflow(api, ref);
	if (opts.json) return printJson(wf);
	printWorkflowDetail(wf);
});

withCommon(
	workflows
		.command('create [json]')
		.description('Create a workflow from a JSON definition (states carry initial "prompt" instructions)')
		.option('-f, --file <path>', 'read the JSON definition from a file ("-" for stdin)')
		.option('--no-prompts', 'allow states without initial "prompt" instructions')
		.addHelpText('after', WORKFLOW_JSON_HELP)
).action(async (inline: string | undefined, opts: CommonOpts & { file?: string; prompts?: boolean }) => {
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
});

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

// --- issues ------------------------------------------------------------------

const issues = program.command('issues').description('Work with issues');

withList(
	issues
		.command('list')
		.description('List issues across projects (hides done issues unless --all)')
		.option('-p, --project <name>', 'filter by project name or id')
		.option('-s, --state <name>', 'filter by state name or id')
		.option('-c, --category <cat>', 'filter by state category')
		.option('-w, --workflow <id-or-name>', 'filter by workflow')
		.option('-a, --all', 'include issues in done states')
		.option('--ready', 'only issues that are actionable now (not done, not a duplicate, no open blockers)')
		.option('-q, --search <text>', 'search titles and descriptions')
).action(
	async (
		opts: ListOpts & {
			project?: string;
			state?: string;
			category?: StateCategory;
			workflow?: string;
			all?: boolean;
			ready?: boolean;
			search?: string;
		}
	) => {
		const res = await client(opts).listIssues({
			project: opts.project,
			state: opts.state,
			category: opts.category,
			workflow: opts.workflow,
			hide_done: !opts.all,
			ready: opts.ready,
			q: opts.search,
			limit: opts.limit,
			cursor: opts.cursor
		});
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log(opts.ready ? 'no ready issues' : 'no issues');
			table([
				['REF', 'TITLE', 'STATE', 'CATEGORY', 'LAST ACTIVITY', ''],
				...items.map((i) => [
					`${i.project_name}/${i.number}`,
					i.title,
					// Duplicates display their canonical issue's state, so lists
					// (and the filters above) go by the effective state.
					i.effective_state.name,
					i.effective_state.category,
					timestamp(i.last_activity_at),
					[i.open_blockers.length > 0 ? 'blocked' : '', i.duplicate_of ? 'dup' : '']
						.filter(Boolean)
						.join(' ')
				])
			]);
		});
	}
);

withCommon(
	issues
		.command('create <project>')
		.description('Create an issue in a project, optionally with a recurrence (a scheduled task)')
		.requiredOption('-t, --title <title>', 'issue title (doubles as the title template with a recurrence)')
		.option('-d, --description <markdown>', 'issue description (Markdown)')
		.option('-w, --workflow <id-or-name>', 'workflow (defaults to project default, else standard)')
		.option('-s, --state <name>', "starting state (defaults to the workflow's initial state)")
		.option('--every <preset>', 'repeat hourly (or every N hours: "6h"), daily, weekly, or monthly')
		.option('--at <when>', 'preset time of day HH:MM (default 09:00); for hourly, the minute past the hour :MM (default :00)')
		.option('--on <when>', 'weekday (weekly) or day of month (monthly)')
		.option('--cron <expr>', '5-field cron expression (alternative to --every/--at/--on)')
		.option('--tz <iana>', 'schedule timezone (defaults to the system timezone)')
		.option('--if-closed', 'only create a new instance when all previous instances are closed')
		.option('--schedule-name <name>', 'schedule name, unique per project (defaults to the title)')
).action(
	async (
		projectRef: string,
		opts: CommonOpts &
			RecurrenceOpts & {
				title: string;
				description?: string;
				workflow?: string;
				state?: string;
				ifClosed?: boolean;
				scheduleName?: string;
			}
	) => {
		const api = client(opts);
		const project = await resolveProject(api, projectRef);
		const workflowId = opts.workflow ? (await resolveWorkflow(api, opts.workflow)).id : undefined;
		const recurrence = buildRecurrence(opts);
		if (!recurrence && (opts.ifClosed !== undefined || opts.scheduleName !== undefined)) {
			die('--if-closed/--schedule-name need a recurrence: add --every … or --cron "<expr>"');
		}
		const schedule: CreateScheduleInput | undefined = recurrence
			? {
					...recurrence,
					name: opts.scheduleName,
					timezone: opts.tz ?? systemTimezone(),
					require_all_closed: opts.ifClosed ?? false
				}
			: undefined;
		const issue = await api.createIssue(project.id, {
			title: opts.title,
			description: opts.description,
			workflow_id: workflowId,
			state: opts.state,
			schedule
		});
		if (opts.json) return printJson(issue);
		console.log(
			`created ${issue.project_name}/#${issue.number} "${issue.title}" in state "${issue.state.name}"`
		);
		if (issue.schedule) {
			console.log(
				`created schedule "${issue.project_name}/${issue.schedule.name}": ${recurrenceLabel(issue.schedule)} — next run ${timestamp(issue.schedule.next_run_at)}`
			);
		}
	}
);

withCommon(
	issues
		.command('show <ref>')
		.description('Show an issue (<project>/<number>), including allowed transitions')
).action(async (ref: string, opts: CommonOpts) => {
	const issue = await resolveIssue(client(opts), ref);
	if (opts.json) return printJson(issue);
	printIssueDetail(issue);
});

withCommon(
	issues
		.command('edit <ref>')
		.description('Edit an issue: title, description, workflow, or force-set state')
		.option('-t, --title <title>', 'set the title')
		.option('-d, --description <markdown>', 'set the description (Markdown)')
		.option(
			'-s, --state <name>',
			"force-set the state, bypassing the workflow's transitions (records a forced move)"
		)
		.option('-w, --workflow <id-or-name>', 'move the issue onto another workflow')
).action(
	async (
		ref: string,
		opts: CommonOpts & { title?: string; description?: string; state?: string; workflow?: string }
	) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const body: UpdateIssueRequest = {};
		if (opts.title !== undefined) body.title = opts.title;
		if (opts.description !== undefined) body.description = opts.description;
		if (opts.state !== undefined) body.state = opts.state;
		if (opts.workflow !== undefined) body.workflow_id = (await resolveWorkflow(api, opts.workflow)).id;
		if (Object.keys(body).length === 0) {
			die('nothing to update: pass --title, --description, --state, and/or --workflow');
		}
		const updated = await api.updateIssue(issue.id, body);
		if (opts.json) return printJson(updated);
		const notes: string[] = [];
		if (body.title !== undefined) notes.push(`title "${updated.title}"`);
		if (body.description !== undefined) notes.push('description');
		if (body.workflow_id !== undefined) notes.push(`workflow "${updated.workflow.name}"`);
		if (updated.state.id !== issue.state.id) {
			notes.push(`state ${issue.state.name} → ${updated.state.name}`);
		}
		console.log(`updated ${updated.project_name}/#${updated.number}: ${notes.join(', ')}`);
	}
);

withCommon(
	issues
		.command('move <ref> <action>')
		.description('Take a transition on an issue by its action name (e.g. "approve")')
).action(async (ref: string, action: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const moved = await api.transitionIssue(issue.id, { action });
	if (opts.json) return printJson(moved);
	console.log(
		`${moved.project_name}/#${moved.number}: ${issue.state.name} → ${moved.state.name} ("${action}")`
	);
});

withCommon(
	issues
		.command('comment <ref> <markdown>')
		.description('Comment on an issue (Markdown body)')
		// A body may start with "-"; options go before the arguments.
		.passThroughOptions()
).action(async (ref: string, markdown: string, opts: CommonOpts, command: Command) => {
	if (helpGuard(command, markdown)) return;
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const comment = await api.createComment(issue.id, { body: markdown });
	if (opts.json) return printJson(comment);
	console.log(`commented on ${issue.project_name}/#${issue.number} as ${actorLabel(comment.actor)}`);
});

// Links read as sentences: `block A B` means "A blocks B", `duplicate A B`
// means "A is a duplicate of B". Link ids never surface — the un- commands
// look the removal up on the issue's own detail.

withCommon(
	issues
		.command('block <blocker> <blocked>')
		.description('Record that <blocker> blocks <blocked> (advisory: transitions stay allowed)')
).action(async (blockerRef: string, blockedRef: string, opts: CommonOpts) => {
	const api = client(opts);
	const blocker = await resolveIssue(api, blockerRef);
	const blocked = await resolveIssue(api, blockedRef);
	const link = await api.addIssueLink(blocked.id, { kind: 'blocked_by', issue_id: blocker.id });
	if (opts.json) return printJson(link);
	console.log(
		`${blocker.project_name}/#${blocker.number} now blocks ${blocked.project_name}/#${blocked.number} "${blocked.title}"`
	);
});

withCommon(
	issues.command('unblock <blocker> <blocked>').description('Remove the link making <blocker> block <blocked>')
).action(async (blockerRef: string, blockedRef: string, opts: CommonOpts) => {
	const api = client(opts);
	const blocker = await resolveIssue(api, blockerRef);
	const blocked = await resolveIssue(api, blockedRef);
	const link = blocked.links.blocked_by.find((l) => l.issue_id === blocker.id);
	if (!link) {
		die(
			`${blocked.project_name}/#${blocked.number} is not blocked by ${blocker.project_name}/#${blocker.number}` +
				` (blocked by: ${blocked.links.blocked_by.map(issueRef).join(', ') || 'nothing'})`
		);
	}
	await api.removeIssueLink(blocked.id, link.link_id);
	if (opts.json) return printJson({ removed: link });
	console.log(
		`${blocker.project_name}/#${blocker.number} no longer blocks ${blocked.project_name}/#${blocked.number}`
	);
});

withCommon(
	issues
		.command('duplicate <ref> <canonical>')
		.alias('dupe')
		.description('Mark <ref> as a duplicate of <canonical> (its state then follows <canonical>)')
).action(async (ref: string, canonicalRef: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const canonical = await resolveIssue(api, canonicalRef);
	const link = await api.addIssueLink(issue.id, { kind: 'duplicate_of', issue_id: canonical.id });
	if (opts.json) return printJson(link);
	console.log(
		`${issue.project_name}/#${issue.number} is now a duplicate of ${canonical.project_name}/#${canonical.number} "${canonical.title}" — showing its state (${canonical.effective_state.name})`
	);
});

withCommon(
	issues
		.command('context <ref>')
		.description("Print an issue's effective context (the assembled bundle for its current state)")
		.option('--out <dir>', 'write the bundle to a directory: prompt.md, skills/<name>/…, repos.json')
		.option('--force', 'allow --out into a non-empty directory')
).action(async (ref: string, opts: CommonOpts & { out?: string; force?: boolean }) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const context = await api.getIssueContext(issue.id);
	if (opts.json && !opts.out) return printJson(context);
	if (opts.out === undefined) {
		if (context.prompt.text) console.log(context.prompt.text);
		if (context.skills.length > 0) {
			console.log(`\nskills: ${context.skills.map((s) => s.name).join(', ')}`);
		}
		for (const repo of context.repos) {
			console.log(`repo: ${repo.name} ${repo.url}${repo.branch ? `#${repo.branch}` : ''} → ${repo.dir}/`);
		}
		for (const o of context.overridden) {
			console.log(`overridden: ${o.kind} "${o.name}" [${o.scope.label}] (overridden by ${o.overridden_by})`);
		}
		for (const c of context.conflicts) {
			console.log(`conflict: repos ${c.item_ids.join(', ')} all resolve to checkout dir "${c.dir}"`);
		}
		return;
	}
	// --out: the workspace-seeding shape. Conflicting checkout dirs make the
	// bundle ambiguous, so refuse entirely while any are reported.
	if (context.conflicts.length > 0) {
		die(
			`refusing to write: checkout-directory conflict${context.conflicts.length === 1 ? '' : 's'} among the effective repos (${context.conflicts
				.map((c) => `"${c.dir}": ${c.item_ids.join(', ')}`)
				.join('; ')}); rename or re-dir the items first`
		);
	}
	if (existsSync(opts.out) && readdirSync(opts.out).length > 0 && !opts.force) {
		die(`refusing to write into non-empty directory ${opts.out} (pass --force to override)`);
	}
	mkdirSync(opts.out, { recursive: true });
	writeFileSync(join(opts.out, 'prompt.md'), context.prompt.text ? `${context.prompt.text}\n` : '');
	for (const skill of context.skills) {
		for (const file of skill.files) {
			const target = join(opts.out, 'skills', skill.name, file.path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, file.content);
		}
	}
	writeFileSync(join(opts.out, 'repos.json'), `${JSON.stringify(context.repos, null, 2)}\n`);
	console.log(
		`wrote ${opts.out}/prompt.md, ${context.skills.length} skill${context.skills.length === 1 ? '' : 's'}, repos.json (${context.repos.length} repo${context.repos.length === 1 ? '' : 's'})`
	);
});

withCommon(
	issues
		.command('unduplicate <ref>')
		.alias('undupe')
		.description('Unmark a duplicate (its own state was never changed, so it simply reappears)')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const link = issue.links.duplicate_of;
	if (!link) die(`${issue.project_name}/#${issue.number} is not marked as a duplicate`);
	await api.removeIssueLink(issue.id, link.link_id);
	if (opts.json) return printJson({ removed: link });
	console.log(
		`${issue.project_name}/#${issue.number} is no longer a duplicate of ${issueRef(link)} — state ${issue.state.name} (${issue.state.category})`
	);
});

withCommon(
	issues
		.command('prompt <ref>')
		.description('Print the launch prompt: the stitched context followed by the issue block')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const prompt = await api.getIssuePrompt(issue.id);
	if (opts.json) return printJson(prompt);
	console.log(prompt.text);
});

// --- issue artifacts ---------------------------------------------------------
// Work products attached along the way — files, text documents, links, PR
// references — versioned, and the currency that workflow transition
// requirements gate on (specs/artifacts/SPEC.md).

const artifactsCmd = issues
	.command('artifacts')
	.description('Typed, versioned attachments on an issue — the work products transition requirements gate on');

const MIME_BY_EXT: Record<string, string> = {
	md: 'text/markdown',
	markdown: 'text/markdown',
	txt: 'text/plain',
	log: 'text/plain',
	html: 'text/html',
	htm: 'text/html',
	css: 'text/css',
	csv: 'text/csv',
	js: 'text/javascript',
	json: 'application/json',
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	zip: 'application/zip',
	gz: 'application/gzip',
	mp4: 'video/mp4',
	webm: 'video/webm'
};

function sniffContentType(path: string): string {
	const ext = path.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
	return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream';
}

/** `owner/repo#N` for a pr version (falls back to the raw URL parts). */
function prRefLabel(v: Pick<ArtifactVersion, 'pr_repo_url' | 'pr_number'>): string {
	const path = (v.pr_repo_url ?? '').replace(/^https:\/\/github\.com\//, '');
	return `${path}#${v.pr_number}`;
}

function artifactSummary(a: Artifact): string {
	const cv = a.current_version;
	switch (a.artifact_type) {
		case 'file':
			return `${cv.filename} (${cv.content_type}, ${cv.size_bytes} bytes)`;
		case 'text':
			return `${cv.filename} (${cv.content_type})`;
		case 'link':
			return cv.title ? `${cv.title} — ${cv.url}` : (cv.url ?? '');
		case 'pr':
			return `${prRefLabel(cv)} — ${cv.pr_repo_url}/pull/${cv.pr_number}`;
	}
}

withCommon(artifactsCmd.command('list <ref>').description('List the artifacts attached to an issue')).action(
	async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const res = await api.listArtifacts(issue.id);
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('no artifacts attached');
		table([
			['NAME', 'TYPE', 'VERSION', 'FRESH', 'SUMMARY', 'ATTACHED'],
			...res.items.map((a) => [
				a.name,
				a.artifact_type,
				`v${a.current_version.version}`,
				a.fresh ? 'yes' : 'no',
				artifactSummary(a),
				timestamp(a.current_version.created_at)
			])
		]);
	}
);

withCommon(
	artifactsCmd.command('show <ref> <name>').description('Show an artifact with its full version history')
).action(async (ref: string, name: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const artifact = await api.getArtifact(issue.id, name);
	if (opts.json) return printJson(artifact);
	console.log(`${artifact.artifact_type} artifact "${artifact.name}" on ${issue.project_name}/${issue.number}`);
	if (artifact.description) console.log(artifact.description);
	console.log(
		`current: v${artifact.current_version.version} (${artifact.fresh ? 'fresh' : 'attached before the current state — reaffirm or attach a new version to satisfy gates'})`
	);
	console.log(`summary: ${artifactSummary(artifact)}`);
	console.log('\nversions:');
	table(
		artifact.versions.map((v) => [
			`  v${v.version}`,
			timestamp(v.created_at),
			actorLabel(v.actor),
			v.reaffirmed_from !== null
				? `reaffirmed v${v.reaffirmed_from}`
				: (v.filename ?? v.url ?? (v.pr_repo_url ? prRefLabel(v) : ''))
		])
	);
});

withCommon(
	artifactsCmd
		.command('attach <ref> <name>')
		.description('Attach content to a named artifact slot (creates it, or appends the next version)')
		.option('-f, --file <path>', 'upload a file (MIME sniffed from the extension)')
		.option('-t, --text <md|@file>', 'inline text document: inline Markdown or @file')
		.option('--url <url>', 'link: the URL to attach')
		.option('--pr <spec>', 'PR reference: owner/repo#N or a GitHub PR URL')
		.option('--content-type <mime>', 'declared MIME type (with --file or --text)')
		.option('--filename <name>', 'display filename (with --text; defaults to <name>.md)')
		.option('--title <title>', 'display title (with --url)')
		.option('-d, --description <text>', 'artifact description, shown in lists and launch prompts'),
	// --url is the link payload here; the API base comes from TINES_API_URL.
	{ baseUrlFlag: false }
).action(
	async (
		ref: string,
		name: string,
		opts: CommonOpts & {
			file?: string;
			text?: string;
			url?: string;
			pr?: string;
			contentType?: string;
			filename?: string;
			title?: string;
			description?: string;
		}
	) => {
		const api = client({ apiKey: opts.apiKey, json: opts.json });
		const sources = [opts.file, opts.text, opts.url, opts.pr].filter((v) => v !== undefined);
		if (sources.length !== 1) {
			die('pass exactly one content source: --file <path>, --text <md|@file>, --url <url>, or --pr <spec>');
		}
		const issue = await resolveIssue(api, ref);
		let artifact: Artifact;
		if (opts.file !== undefined) {
			let bytes: Buffer;
			try {
				bytes = readFileSync(opts.file);
			} catch (err) {
				die(`cannot read ${opts.file}: ${err instanceof Error ? err.message : String(err)}`);
			}
			artifact = await api.uploadArtifactFile(issue.id, name, bytes, {
				filename: opts.filename ?? basename(opts.file),
				contentType: opts.contentType ?? sniffContentType(opts.file)
			});
			// The file endpoint has no description slot; set it alongside.
			if (opts.description !== undefined) {
				artifact = await api.putArtifact(issue.id, name, { description: opts.description });
			}
		} else if (opts.text !== undefined) {
			artifact = await api.putArtifact(issue.id, name, {
				type: 'text',
				content: readBodyValue(opts.text),
				...(opts.filename !== undefined ? { filename: opts.filename } : {}),
				...(opts.contentType !== undefined ? { content_type: opts.contentType } : {}),
				...(opts.description !== undefined ? { description: opts.description } : {})
			});
		} else if (opts.url !== undefined) {
			artifact = await api.putArtifact(issue.id, name, {
				type: 'link',
				url: opts.url,
				...(opts.title !== undefined ? { title: opts.title } : {}),
				...(opts.description !== undefined ? { description: opts.description } : {})
			});
		} else {
			const parsed = parsePrSpec(opts.pr!);
			if (!parsed) {
				die(`--pr takes owner/repo#N or a GitHub PR URL, got "${opts.pr}"`);
			}
			artifact = await api.putArtifact(issue.id, name, {
				type: 'pr',
				pr_repo_url: parsed.repo_url,
				pr_number: parsed.number,
				...(opts.description !== undefined ? { description: opts.description } : {})
			});
		}
		if (opts.json) return printJson(artifact);
		console.log(
			`attached "${artifact.name}" v${artifact.current_version.version} (${artifactSummary(artifact)}) to ${issue.project_name}/${issue.number} — fresh`
		);
	}
);

withCommon(
	artifactsCmd
		.command('reaffirm <ref> <name>')
		.description('Bless the current content as fresh (appends a version reusing the same payload)')
).action(async (ref: string, name: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const artifact = await api.reaffirmArtifact(issue.id, name);
	if (opts.json) return printJson(artifact);
	console.log(
		`reaffirmed "${artifact.name}" on ${issue.project_name}/${issue.number}: v${artifact.current_version.version} reaffirms v${artifact.current_version.reaffirmed_from} — fresh as of now`
	);
});

withCommon(
	artifactsCmd
		.command('get <ref> <name>')
		.description('Fetch content (current version by default); a link/pr prints its URL')
		.option('--version <n>', 'fetch a specific version from the history', (v) => Number.parseInt(v, 10))
		.option('--out <path>', 'write to this file, or into this directory (keeps the stored filename)')
).action(
	async (ref: string, name: string, opts: CommonOpts & { version?: number; out?: string }) => {
		const api = client(opts);
		const issue = await resolveIssue(api, ref);
		const artifact = await api.getArtifact(issue.id, name);
		const version =
			opts.version === undefined
				? artifact.current_version
				: artifact.versions.find((v) => v.version === opts.version);
		if (!version) {
			die(
				`artifact "${name}" has no version ${opts.version} (history: v1–v${artifact.current_version.version})`
			);
		}
		if (artifact.artifact_type === 'link' || artifact.artifact_type === 'pr') {
			const url =
				artifact.artifact_type === 'link' ? version.url : `${version.pr_repo_url}/pull/${version.pr_number}`;
			if (opts.json) return printJson({ url });
			return console.log(url);
		}
		const content = await api.getArtifactContent(issue.id, name, { version: opts.version });
		const bytes = Buffer.from(content.bytes);
		if (opts.out !== undefined) {
			let target = opts.out;
			if (existsSync(target) && statSync(target).isDirectory()) {
				target = join(target, version.filename ?? name);
			}
			writeFileSync(target, bytes);
			return console.log(`wrote ${target} (${bytes.byteLength} bytes, ${content.content_type})`);
		}
		if ((content.content_type ?? '').startsWith('text/')) {
			process.stdout.write(bytes);
			return;
		}
		const target = version.filename ?? name;
		writeFileSync(target, bytes);
		console.log(`wrote ${target} (${bytes.byteLength} bytes, ${content.content_type})`);
	}
);

withCommon(
	artifactsCmd
		.command('delete <ref> <name>')
		.description('Delete an artifact — every version and its stored files (history is not recoverable)')
).action(async (ref: string, name: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const artifact = await api.getArtifact(issue.id, name);
	await api.deleteArtifact(issue.id, name);
	console.log(
		`deleted ${artifact.artifact_type} artifact "${name}" from ${issue.project_name}/${issue.number} (${artifact.version_count} version${artifact.version_count === 1 ? '' : 's'})`
	);
});

// --- issue pins --------------------------------------------------------------

withCommon(
	issues
		.command('assign <ref> [runner]')
		.description('Pin an issue to a runner (<runner>[:tier]) — replaces routing rules for it; --clear unpins')
		.option('--clear', 'remove the pin')
).action(async (ref: string, runnerSpec: string | undefined, opts: CommonOpts & { clear?: boolean }) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	if (opts.clear) {
		if (runnerSpec !== undefined) die('--clear does not take a runner');
		const updated = await api.updateIssue(issue.id, { pinned_runner_id: null });
		if (opts.json) return printJson(updated);
		return console.log(`unpinned ${updated.project_name}/#${updated.number} — routing rules apply again`);
	}
	if (runnerSpec === undefined) die('pass <runner>[:tier] to pin, or --clear to unpin');
	const { name, tier } = parseTargetSpec(runnerSpec);
	const runner = await resolveRunner(api, name);
	const updated = await api.updateIssue(issue.id, {
		pinned_runner_id: runner.id,
		pinned_tier: tier ?? null
	});
	if (opts.json) return printJson(updated);
	console.log(
		`pinned ${updated.project_name}/#${updated.number} to ${runner.name}${tier ? ` (tier ${tier})` : ''} — only this runner will take it`
	);
});

withCommon(
	issues
		.command('dispatch <ref>')
		.description('Explain why an issue is (not) dispatching: eligibility, routing, per-runner verdicts')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const ex = await api.getIssueDispatch(issue.id);
	if (opts.json) return printJson(ex);
	printExplainer(issue, ex);
});

withCommon(
	issues
		.command('resume <ref>')
		.description('Un-park an issue: clear needs-attention and reset the attempt count')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const updated = await api.resumeIssue(issue.id);
	if (opts.json) return printJson(updated);
	console.log(
		issue.needs_attention || issue.attempt_count > 0
			? `resumed ${updated.project_name}/#${updated.number} — attempt count reset, back in the pool`
			: `${updated.project_name}/#${updated.number} was not parked — nothing to do`
	);
});

function printExplainer(issue: IssueDetail, ex: DispatchExplainer): void {
	console.log(`${issue.project_name}/#${issue.number}  ${issue.title}`);
	console.log(`\n${ex.verdict}\n`);
	table(ex.checks.map((c) => [`  ${c.ok ? 'ok' : 'FAIL'}`, c.name.replaceAll('_', ' '), c.detail]));
	if (ex.pin) {
		console.log(
			`\npinned to ${ex.pin.runner_name ?? ex.pin.runner_id}${ex.pin.tier ? `:${ex.pin.tier}` : ''} (replaces rule matching)`
		);
	} else if (ex.matched_rule) {
		console.log(`\nmatched rule: ${ex.matched_rule.scope_label}`);
	}
	if (ex.targets.length > 0) {
		console.log('targets (preference order):');
		table(
			ex.targets.map((t) => [
				`  ${t.runner_name}`,
				`${t.tier} → ${t.model ?? '(model n/a)'}`,
				t.verdict === 'ok' ? 'available' : t.verdict.replaceAll('_', ' '),
				t.verdict === 'ok' ? '' : t.detail
			])
		);
	}
	if (ex.queue_position !== null && ex.queue_position > 0) {
		console.log(`queue: ${ex.queue_position} eligible issue${ex.queue_position === 1 ? '' : 's'} ahead of this one`);
	}
	if (ex.active_run) {
		console.log(
			`active run: ${ex.active_run.id} on ${ex.active_run.runner_name} (${ex.active_run.status})`
		);
	}
	if (ex.parked) {
		console.log(
			`parked after ${ex.attempt_count}/${ex.attempt_limit} strikes — \`tines issues resume\` (or any manual transition) revives it`
		);
	}
}

// --- context -----------------------------------------------------------------

const context = program
	.command('context')
	.description('Manage context items (prompts, skills, repo pointers) scoped to projects, states, and issues');

const SCOPE_FLAGS_HELP = `
Scope flags (combinable — an item applies where ALL of its set dimensions match):
  --project <name>              only for issues in this project
  --state <workflow>/<state>    only for issues currently in this state
  --issue <project>/<number>    only for this issue
`;

function withScopeFlags(cmd: Command): Command {
	return cmd
		.option('-p, --project <name>', 'scope: project name or id')
		.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
		.option('-i, --issue <ref>', 'scope: issue (<project>/<number>)')
		.addHelpText('after', SCOPE_FLAGS_HELP);
}

withList(
	withScopeFlags(
		context
			.command('list')
			.description('List context items (scope filters match every item whose scope includes the element)')
			.option('-k, --kind <kind>', 'filter by kind: prompt, skill, or repo')
			.option('--exact', 'only items whose scope sets exactly the given dimensions')
			.option('-q, --search <text>', 'search names and descriptions')
	)
).action(async (opts: ListOpts & ScopeFlagOpts & { kind?: ContextKind; exact?: boolean; search?: string }) => {
	const api = client(opts);
	const scope = await resolveScopeFlags(api, opts);
	const res = await api.listContext({
		kind: opts.kind,
		project: scope.project_id ?? undefined,
		state: scope.workflow_state_id ?? undefined,
		issue: scope.issue_id ?? undefined,
		q: opts.search,
		exact: opts.exact ? true : undefined,
		limit: opts.limit,
		cursor: opts.cursor
	});
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
});

withCommon(context.command('show <id>').description('Show a context item (skills include their files)')).action(
	async (id: string, opts: CommonOpts) => {
		const item = await client(opts).getContextItem(id);
		if (opts.json) return printJson(item);
		printContextItem(item);
	}
);

withCommon(
	withScopeFlags(
		context
			.command('create')
			.description('Create a context item scoped to a project, state, and/or issue')
			.requiredOption('-k, --kind <kind>', 'prompt, skill, or repo')
			.requiredOption('-n, --name <name>', 'item name (slug-like for skills; the dedup/override key)')
			.option('-d, --description <text>', 'one-liner shown in lists')
			.option('--body <md>', 'prompt body: inline Markdown or @file (escape a literal @ as @@)')
			.option('--file <path>=@<local>', 'skill file: workspace path = local file (repeatable)', collect, [])
			.option('--url <url>', 'repo: clone URL')
			.option('--branch <branch>', 'repo: branch to check out')
			.option('--dir <dir>', "repo: checkout directory (defaults to the URL's basename)")
	),
	// --url is the repo pointer here; the API base comes from TINES_API_URL.
	{ baseUrlFlag: false }
).action(
	async (
		opts: CommonOpts &
			ScopeFlagOpts & {
				kind: string;
				name: string;
				description?: string;
				body?: string;
				file: string[];
				url?: string;
				branch?: string;
				dir?: string;
			}
	) => {
		// opts.url is the repo pointer on this command, not the API base.
		const api = client({ apiKey: opts.apiKey, json: opts.json });
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
		if (opts.url !== undefined) body.repo_url = opts.url;
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
			.option('--url <url>', 'repo: clone URL')
			.option('--branch <branch>', 'repo: branch (empty string clears it)')
			.option('--dir <dir>', 'repo: checkout directory (empty string restores the URL default)')
			.option('--unset <dimension>', 'drop a scope dimension: project, state, or issue (repeatable)', collect, [])
			.option('--expect-version <n>', 'fail (409) unless the item is still at this version', (v) =>
				Number.parseInt(v, 10)
			)
	),
	// --url is the repo pointer here; the API base comes from TINES_API_URL.
	{ baseUrlFlag: false }
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
				url?: string;
				branch?: string;
				dir?: string;
				unset: string[];
				expectVersion?: number;
			}
	) => {
		// opts.url is the repo pointer on this command, not the API base.
		const api = client({ apiKey: opts.apiKey, json: opts.json });
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
			else die(`--unset takes project, state, or issue, got "${dim}"`);
		}
		if (opts.body !== undefined) body.body = readBodyValue(opts.body);
		if (opts.file.length > 0 || opts.removeFile.length > 0) {
			// Skill files PATCH declaratively: fetch, apply the edits, send the
			// full list. --file replaces an existing path or adds a new one.
			const current = await api.getContextItem(id);
			if (current.kind !== 'skill') die(`--file/--remove-file only apply to skills (this is a ${current.kind})`);
			// The full-list PATCH is built from the files just read, so pin the
			// write to that read: a concurrent file edit becomes a 409 instead
			// of being silently replaced by this stale list.
			if (body.expected_version === undefined) body.expected_version = current.version;
			const files = new Map((current.files ?? []).map((f) => [f.path, f.content]));
			for (const path of opts.removeFile) {
				if (!files.delete(path)) {
					die(`no file "${path}" in skill "${current.name}" (have: ${[...files.keys()].join(', ') || 'none'})`);
				}
			}
			for (const spec of opts.file) {
				const f = parseFileSpec(spec);
				files.set(f.path, f.content);
			}
			body.files = [...files.entries()].map(([path, content]) => ({ path, content }));
		}
		if (opts.url !== undefined) body.repo_url = opts.url;
		if (opts.branch !== undefined) body.repo_branch = opts.branch === '' ? null : opts.branch;
		if (opts.dir !== undefined) body.repo_dir = opts.dir === '' ? null : opts.dir;
		if (Object.keys(body).length === 0) {
			die('nothing to update: pass payload flags, --name/--description, scope flags, and/or --unset');
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
	const { items } = await api.listContext({ kind: 'prompt', exact: true, limit: 100 });
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

// --- journal -----------------------------------------------------------------
// The id-free path to the one item agents maintain routinely: the prompt
// named "journal" at exactly the issue's project ∧ current state.

const journal = program
	.command('journal')
	.description("An issue's stage journal: shared notes for its project + current state");

async function resolveJournal(
	api: ApiClient,
	ref: string
): Promise<{ issue: IssueDetail; item: ContextItem | null }> {
	const issue = await resolveIssue(api, ref);
	const { items } = await api.listContext({
		kind: 'prompt',
		project: issue.project_id,
		state: issue.state.id,
		exact: true,
		limit: 100
	});
	return { issue, item: items.find((i) => i.name === JOURNAL_NAME) ?? null };
}

withCommon(
	journal.command('show <ref>').description("Print the journal for the issue's project and current state")
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const { issue, item } = await resolveJournal(api, ref);
	if (!item) {
		die(
			`no journal exists yet for project ${issue.project_name} · state ${issue.state.name}\nstart one: tines journal append ${issue.project_name}/${issue.number} "- <date>: <lesson>"`
		);
	}
	const full = await api.getContextItem(item.id);
	if (opts.json) return printJson(full);
	console.log(`journal for project ${issue.project_name} · state ${issue.state.name}  (v${full.version})`);
	console.log('');
	console.log(full.body ?? '');
});

withCommon(
	journal
		.command('append <ref> <markdown>')
		.description('Append a lesson (creates the journal on first use)')
		// Lessons are dated bullets starting with "-"; options go before the
		// arguments, exactly as the launch prompt's copy-pasteable command has it.
		.passThroughOptions()
).action(async (ref: string, markdown: string, opts: CommonOpts, command: Command) => {
	if (helpGuard(command, markdown)) return;
	const api = client(opts);
	const { issue, item } = await resolveJournal(api, ref);
	const scopeLabel = `project ${issue.project_name} · state ${issue.state.name}`;
	if (item) {
		const updated = await api.appendContextItem(item.id, { text: markdown });
		if (opts.json) return printJson(updated);
		return console.log(`appended to the ${scopeLabel} journal (now v${updated.version})`);
	}
	try {
		const created = await api.createContextItem({
			kind: 'prompt',
			name: JOURNAL_NAME,
			project_id: issue.project_id,
			workflow_state_id: issue.state.id,
			body: markdown.trim()
		});
		if (opts.json) return printJson(created);
		console.log(`started the ${scopeLabel} journal (${created.id})`);
	} catch (err) {
		// Create race: someone else started the journal between the lookup
		// and the insert — append to theirs instead.
		if (!(err instanceof ApiError) || err.code !== 'duplicate_context_name') throw err;
		const { item: fresh } = await resolveJournal(api, ref);
		if (!fresh) throw err;
		const updated = await api.appendContextItem(fresh.id, { text: markdown });
		if (opts.json) return printJson(updated);
		console.log(`appended to the ${scopeLabel} journal (now v${updated.version})`);
	}
});

withCommon(
	journal
		.command('rewrite <ref>')
		.description('Replace the journal body (to fix or prune entries) — version-checked')
		.requiredOption('--body <md>', 'the full new body: inline Markdown or @file')
		.requiredOption('--expect-version <n>', 'the version being replaced (from the prompt or journal show)', (v) =>
			Number.parseInt(v, 10)
		)
).action(async (ref: string, opts: CommonOpts & { body: string; expectVersion: number }) => {
	const api = client(opts);
	const { issue, item } = await resolveJournal(api, ref);
	if (!item) {
		die(
			`no journal exists yet for project ${issue.project_name} · state ${issue.state.name}; nothing to rewrite`
		);
	}
	const updated = await api.updateContextItem(item.id, {
		body: readBodyValue(opts.body),
		expected_version: opts.expectVersion
	});
	if (opts.json) return printJson(updated);
	console.log(
		`rewrote the project ${issue.project_name} · state ${issue.state.name} journal (now v${updated.version})`
	);
});

// --- schedules ---------------------------------------------------------------

const schedules = program
	.command('schedules')
	.description('Manage scheduled tasks (addressed as <project>/<name>)');

function scheduleRef(s: Schedule): string {
	return `${s.project_name}/${s.name}`;
}

function printScheduleDetail(s: Schedule): void {
	console.log(`${scheduleRef(s)}  [${s.id}]${s.enabled ? '' : '  (paused)'}`);
	console.log(`${recurrenceLabel(s)} (cron "${s.cron}")`);
	console.log(
		`gate: ${s.require_all_closed ? 'only create when previous instances are closed' : 'off'}  workflow: ${s.workflow_name}  start state: ${s.state_name ?? '(initial)'}`
	);
	console.log(
		`next run: ${s.enabled ? timestamp(s.next_run_at) : '(paused)'}  last run: ${s.last_run_at ? timestamp(s.last_run_at) : 'never'}  runs: ${s.run_count}  open instances: ${s.open_instances}`
	);
	console.log(`\ntitle template: ${s.title_template}`);
	if (s.description_template) {
		console.log('description template:');
		for (const line of s.description_template.split('\n')) console.log(`  ${line}`);
	}
}

withList(
	schedules
		.command('list')
		.description('List scheduled tasks (hides paused schedules unless --all)')
		.option('-p, --project <name>', 'filter by project name or id')
		.option('-a, --all', 'include paused schedules')
).action(async (opts: ListOpts & { project?: string; all?: boolean }) => {
	const res = await client(opts).listSchedules({
		project: opts.project,
		enabled: opts.all ? undefined : true,
		limit: opts.limit,
		cursor: opts.cursor
	});
	printList(res, opts, (items) => {
		if (items.length === 0) return console.log('no schedules');
		table([
			['NAME', 'RECURRENCE', 'NEXT RUN', 'LAST RUN', 'OPEN', ''],
			...items.map((s) => [
				scheduleRef(s),
				recurrenceLabel(s),
				s.enabled ? timestamp(s.next_run_at) : '—',
				s.last_run_at ? timestamp(s.last_run_at) : 'never',
				String(s.open_instances),
				s.enabled ? '' : '(paused)'
			])
		]);
	});
});

withCommon(
	schedules
		.command('show <ref>')
		.description('Show a schedule (<project>/<name>): config, next/last run, recent instances')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const schedule = await resolveSchedule(api, ref);
	if (opts.json) return printJson(schedule);
	printScheduleDetail(schedule);
	const { items } = await api.listIssues({ schedule: schedule.id, limit: 10 });
	if (items.length > 0) {
		console.log(`\nrecent instances:`);
		table(
			items.map((i) => [
				`  ${i.project_name}/${i.number}`,
				i.title,
				i.state.name,
				timestamp(i.created_at)
			])
		);
	}
});

withCommon(
	schedules
		.command('edit <ref>')
		.description('Edit a schedule: templates, workflow, start state, recurrence, timezone, gate, or name')
		.option('-t, --title <template>', 'set the title template')
		.option('-d, --description <markdown>', 'set the description template (Markdown)')
		.option(
			'-w, --workflow <id-or-name>',
			'move future instances onto another workflow (resets the start state to its initial state unless --state is also given)'
		)
		.option(
			'-s, --state <id-or-name>',
			"start state for future instances (the workflow's initial state = the default)"
		)
		.option('--every <preset>', 'repeat hourly (or every N hours: "6h"), daily, weekly, or monthly')
		.option('--at <when>', 'preset time of day HH:MM (default 09:00); for hourly, the minute past the hour :MM (default :00)')
		.option('--on <when>', 'weekday (weekly) or day of month (monthly)')
		.option('--cron <expr>', '5-field cron expression (alternative to --every/--at/--on)')
		.option('--tz <iana>', 'set the schedule timezone')
		.option('--if-closed', 'only create a new instance when all previous instances are closed')
		.option('--no-if-closed', 'clear the only-when-closed gate')
		.option('--name <new-name>', 'rename the schedule')
).action(
	async (
		ref: string,
		opts: CommonOpts &
			RecurrenceOpts & {
				title?: string;
				description?: string;
				workflow?: string;
				state?: string;
				ifClosed?: boolean;
				name?: string;
			}
	) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const body: UpdateScheduleRequest = {};
		if (opts.title !== undefined) body.title_template = opts.title;
		if (opts.description !== undefined) body.description_template = opts.description;
		if (opts.workflow !== undefined) body.workflow_id = (await resolveWorkflow(api, opts.workflow)).id;
		if (opts.state !== undefined) body.state = opts.state;
		const recurrence = buildRecurrence(opts);
		if (recurrence?.preset) body.preset = recurrence.preset as SchedulePreset;
		if (recurrence?.cron !== undefined) body.cron = recurrence.cron;
		if (opts.tz !== undefined) body.timezone = opts.tz;
		if (opts.ifClosed !== undefined) body.require_all_closed = opts.ifClosed;
		if (opts.name !== undefined) body.name = opts.name;
		if (Object.keys(body).length === 0) {
			die(
				'nothing to update: pass --title, --description, --workflow, --state, --every/--at/--on, --cron, --tz, --[no-]if-closed, and/or --name'
			);
		}
		const updated = await api.updateSchedule(schedule.id, body);
		if (opts.json) return printJson(updated);
		console.log(`updated schedule "${scheduleRef(updated)}"\n`);
		printScheduleDetail(updated);
	}
);

withCommon(schedules.command('pause <ref>').description('Pause a schedule (keeps config and history)')).action(
	async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const updated = await api.updateSchedule(schedule.id, { enabled: false });
		if (opts.json) return printJson(updated);
		console.log(`paused schedule "${scheduleRef(updated)}"`);
	}
);

withCommon(
	schedules
		.command('resume <ref>')
		.description('Resume a paused schedule (recomputes the next occurrence from now)')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const schedule = await resolveSchedule(api, ref);
	const updated = await api.updateSchedule(schedule.id, { enabled: true });
	if (opts.json) return printJson(updated);
	console.log(`resumed schedule "${scheduleRef(updated)}" — next run ${timestamp(updated.next_run_at)}`);
});

withCommon(
	schedules
		.command('run <ref>')
		.description('Create an instance now (respects the only-when-closed gate)')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const schedule = await resolveSchedule(api, ref);
	const issue = await api.runSchedule(schedule.id);
	if (opts.json) return printJson(issue);
	console.log(
		`created ${issue.project_name}/#${issue.number} "${issue.title}" in state "${issue.state.name}"`
	);
});

withCommon(
	schedules
		.command('delete <ref>')
		.description('Delete a schedule (existing issues are kept)')
		.option('-y, --yes', 'skip the confirmation prompt')
).action(async (ref: string, opts: CommonOpts & { yes?: boolean }) => {
	const api = client(opts);
	const schedule = await resolveSchedule(api, ref);
	if (!opts.yes) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question(
			`Delete schedule "${scheduleRef(schedule)}"? Its ${schedule.run_count} existing issue${schedule.run_count === 1 ? '' : 's'} will be kept. [y/N] `
		);
		rl.close();
		if (!/^y(es)?$/i.test(answer.trim())) die('aborted');
	}
	await api.deleteSchedule(schedule.id);
	console.log(`deleted schedule "${scheduleRef(schedule)}" (issues kept)`);
});

// --- runners -----------------------------------------------------------------

async function resolveRunner(api: ApiClient, ref: string): Promise<Runner> {
	const { items } = await api.listRunners();
	const found = items.find((r) => r.name === ref) ?? items.find((r) => r.id === ref);
	if (!found) {
		die(`no runner named "${ref}" (have: ${items.map((r) => r.name).join(', ') || 'none'})`);
	}
	return found;
}

/** `<runner>[:tier]` — the last ":" separates an optional tier. */
function parseTargetSpec(spec: string): { name: string; tier?: ModelTier } {
	const sep = spec.lastIndexOf(':');
	if (sep === -1) return { name: spec };
	const name = spec.slice(0, sep);
	const tier = spec.slice(sep + 1);
	if (!name) die(`target must look like <runner>[:tier], got "${spec}"`);
	if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
		die(`unknown tier "${tier}" in "${spec}" (tiers: ${MODEL_TIERS.join(', ')})`);
	}
	return { name, tier: tier as ModelTier };
}

function runnerStatusLabel(runner: Runner): string {
	if (runner.status === 'paused') return 'paused';
	return runner.online ? 'online' : 'offline';
}

const runners = program.command('runners').description('Manage the runner registry');

withCommon(runners.command('list').description('List runners')).action(async (opts: CommonOpts) => {
	const res = await client(opts).listRunners();
	if (opts.json) return printJson(res);
	if (res.items.length === 0) return console.log('no runners');
	table([
		['NAME', 'TYPE', 'STATUS', 'RUNS', 'TIER', 'LAST SEEN'],
		...res.items.map((r) => [
			r.name,
			r.type,
			runnerStatusLabel(r),
			`${r.active_runs}/${r.max_concurrent}`,
			r.default_tier,
			r.last_seen_at ? timestamp(r.last_seen_at) : '—'
		])
	]);
});

withCommon(runners.command('show <name>').description('Show a runner')).action(
	async (ref: string, opts: CommonOpts) => {
		const runner = await resolveRunner(client(opts), ref);
		if (opts.json) return printJson(runner);
		console.log(`${runner.name}  (${runner.type})  [${runner.id}]  ${runnerStatusLabel(runner)}`);
		console.log(
			`active runs: ${runner.active_runs}/${runner.max_concurrent}  timeout: ${runner.max_run_minutes}m  default tier: ${runner.default_tier}`
		);
		if (runner.last_seen_at) console.log(`last seen: ${timestamp(runner.last_seen_at)}`);
		if (runner.launch_failures > 0) {
			console.log(
				`launch failures: ${runner.launch_failures}${runner.backoff_until ? ` (backing off until ${timestamp(runner.backoff_until)})` : ''}`
			);
		}
		const harness = runner.config.harness;
		if (typeof harness === 'string') console.log(`harness: ${harness}`);
		if (runner.type !== 'local') {
			console.log(`api key: ${runner.has_api_key ? 'set (write-only)' : 'missing'}`);
		}
		if (runner.budget) {
			const b = runner.budget;
			const parts: string[] = [];
			if (b.max_run_cost_usd !== undefined) parts.push(`$${b.max_run_cost_usd}/run`);
			if (b.max_run_tokens !== undefined) parts.push(`${b.max_run_tokens.toLocaleString()} tok/run`);
			if (b.daily_usd !== undefined) parts.push(`$${b.daily_usd}/day`);
			if (b.daily_tokens !== undefined) parts.push(`${b.daily_tokens.toLocaleString()} tok/day`);
			if (parts.length > 0) console.log(`budget: ${parts.join('  ')}`);
		}
		printTierTable(runner);
	}
);

/** The tier mapping, shared by `runners show` and `runners tiers`. */
function printTierTable(runner: Runner): void {
	if (!runner.tier_models && !runner.tiers) {
		console.log("tiers: don't apply to this runner (fixed configuration)");
		return;
	}
	console.log('tiers:');
	for (const tier of MODEL_TIERS) {
		const override = runner.tiers?.[tier];
		const builtin = runner.tier_models?.[tier] ?? null;
		const model = override?.model ?? builtin ?? '(unknown)';
		const source = override ? 'override' : 'built-in';
		const stale = isStaleTierOverride(builtin, override?.model);
		const marks = [
			tier === runner.default_tier ? 'default' : null,
			override?.effort ? `effort ${override.effort}` : null,
			stale ? `stale — built-in is now ${builtin}` : null
		].filter(Boolean);
		console.log(`  ${tier}: ${model}  [${source}]${marks.length > 0 ? `  (${marks.join(', ')})` : ''}`);
	}
}

withCommon(
	runners
		.command('tiers <name>')
		.description("Show or edit a runner's tier→model mapping")
		.option('--default <tier>', 'set the default tier (used by targets without an explicit tier)')
		.option('--set <tier=model...>', 'override a tier with an exact model id (repeatable)')
		.option('--unset <tier...>', 'drop an override, falling back to the built-in (repeatable)')
).action(
	async (
		ref: string,
		opts: CommonOpts & { default?: string; set?: string[]; unset?: string[] }
	) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		const patch: UpdateRunnerRequest = {};
		if (opts.default !== undefined) {
			if (!(MODEL_TIERS as readonly string[]).includes(opts.default)) {
				die(`unknown tier "${opts.default}" (tiers: ${MODEL_TIERS.join(', ')})`);
			}
			patch.default_tier = opts.default as ModelTier;
		}
		if (opts.set?.length || opts.unset?.length) {
			const tiers: Record<string, { model: string; effort?: string } | undefined> = {
				...(runner.tiers ?? {})
			};
			for (const entry of opts.set ?? []) {
				const eq = entry.indexOf('=');
				if (eq === -1) die(`--set takes <tier>=<model-id>, got "${entry}"`);
				const tier = entry.slice(0, eq);
				const model = entry.slice(eq + 1);
				if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
					die(`unknown tier "${tier}" (tiers: ${MODEL_TIERS.join(', ')})`);
				}
				if (!model) die(`--set ${tier}= needs a model id`);
				tiers[tier] = { ...tiers[tier], model };
			}
			for (const tier of opts.unset ?? []) {
				if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
					die(`unknown tier "${tier}" (tiers: ${MODEL_TIERS.join(', ')})`);
				}
				delete tiers[tier];
			}
			patch.tiers = Object.keys(tiers).length > 0 ? (tiers as UpdateRunnerRequest['tiers']) : null;
		}
		const updated =
			Object.keys(patch).length > 0 ? await api.updateRunner(runner.id, patch) : runner;
		if (opts.json) return printJson(updated);
		console.log(`${updated.name}  (${updated.type})  default tier: ${updated.default_tier}`);
		printTierTable(updated);
		if (Object.keys(patch).length > 0) {
			console.log('changes apply at the next launch; running work is untouched.');
		}
	}
);

withCommon(
	runners
		.command('budget <name>')
		.description("Set or clear a runner's money limits (per-run caps enforce now; daily limits arrive with the budgets milestone)")
		.option('--max-run-usd <n>', 'hard per-run cost cap (platform-enforced on Claude runners)')
		.option('--max-run-tokens <n>', 'hard per-run token cap (input + output)')
		.option('--daily-usd <n>', 'daily USD limit (stored now, enforced by the budgets milestone)')
		.option('--daily-tokens <n>', 'daily token limit (stored now, enforced by the budgets milestone)')
		.option('--clear', 'remove all limits')
).action(
	async (
		ref: string,
		opts: CommonOpts & {
			maxRunUsd?: string;
			maxRunTokens?: string;
			dailyUsd?: string;
			dailyTokens?: string;
			clear?: boolean;
		}
	) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		const flags = [opts.maxRunUsd, opts.maxRunTokens, opts.dailyUsd, opts.dailyTokens].some(
			(v) => v !== undefined
		);
		if (opts.clear && flags) die('--clear cannot be combined with limit flags');
		let updated = runner;
		if (opts.clear) {
			updated = await api.updateRunner(runner.id, { budget: null });
		} else if (flags) {
			const num = (value: string, flag: string): number => {
				const n = Number(value);
				if (!Number.isFinite(n) || n <= 0) die(`${flag} must be a positive number, got "${value}"`);
				return n;
			};
			updated = await api.updateRunner(runner.id, {
				budget: {
					...(runner.budget ?? {}),
					...(opts.maxRunUsd !== undefined ? { max_run_cost_usd: num(opts.maxRunUsd, '--max-run-usd') } : {}),
					...(opts.maxRunTokens !== undefined
						? { max_run_tokens: num(opts.maxRunTokens, '--max-run-tokens') }
						: {}),
					...(opts.dailyUsd !== undefined ? { daily_usd: num(opts.dailyUsd, '--daily-usd') } : {}),
					...(opts.dailyTokens !== undefined ? { daily_tokens: num(opts.dailyTokens, '--daily-tokens') } : {})
				}
			});
		}
		if (opts.json) return printJson(updated);
		const b = updated.budget;
		if (!b) return console.log(`no limits on "${updated.name}"`);
		console.log(`limits on "${updated.name}":`);
		if (b.max_run_cost_usd !== undefined) console.log(`  $${b.max_run_cost_usd} per run`);
		if (b.max_run_tokens !== undefined) console.log(`  ${b.max_run_tokens.toLocaleString()} tokens per run`);
		if (b.daily_usd !== undefined) console.log(`  $${b.daily_usd} per day (enforced by the budgets milestone)`);
		if (b.daily_tokens !== undefined) {
			console.log(`  ${b.daily_tokens.toLocaleString()} tokens per day (enforced by the budgets milestone)`);
		}
	}
);

withCommon(
	runners.command('pause <name>').description('Pause a runner (stops new assignments; identity and rules stay)')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const runner = await resolveRunner(api, ref);
	const updated = await api.updateRunner(runner.id, { status: 'paused' });
	if (opts.json) return printJson(updated);
	console.log(`paused runner "${updated.name}"`);
});

withCommon(runners.command('resume <name>').description('Resume a paused runner')).action(
	async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const runner = await resolveRunner(api, ref);
		const updated = await api.updateRunner(runner.id, { status: 'active' });
		if (opts.json) return printJson(updated);
		console.log(`resumed runner "${updated.name}"`);
	}
);

withCommon(
	runners
		.command('remove <name>')
		.description('Remove a runner (refused while routing rules or pins reference it, unless --force)')
		.option('--force', 'strip the runner from routing rules and clear issue pins (emptied rules are kept, flagged)')
).action(async (ref: string, opts: CommonOpts & { force?: boolean }) => {
	const api = client(opts);
	const runner = await resolveRunner(api, ref);
	await api.deleteRunner(runner.id, opts.force ? { force: true } : undefined);
	console.log(`removed runner "${runner.name}"${opts.force ? ' (references stripped)' : ''}`);
});

withCommon(
	runners
		.command('rotate-token <name>')
		.description("Invalidate a local runner's token and mint a fresh one (shown once)")
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const runner = await resolveRunner(api, ref);
	const rotated = await api.rotateRunnerToken(runner.id);
	if (opts.json) return printJson(rotated);
	const url = resolveUrl(opts);
	console.log(`rotated the token for runner "${rotated.runner.name}" — the old token is dead.`);
	console.log(`new token (shown once): ${rotated.runner_token}`);
	if (hasRunnerCredentials(defaultConfigDir(), url, rotated.runner.name)) {
		// This machine runs the daemon: adopt the new token in place so a
		// restart just works.
		saveRunnerCredentials(defaultConfigDir(), url, rotated.runner.name, {
			runner_id: rotated.runner.id,
			token: rotated.runner_token
		});
		console.log(`stored it for the daemon on this machine (${defaultConfigDir()}); restart the daemon to adopt it.`);
	} else {
		console.log('drop it into the daemon machine\'s config — its next poll gets a 401 until it adopts the new token.');
	}
});

// --- runner daemon -----------------------------------------------------------

const runnerCmd = program.command('runner').description('The local runner daemon');

withCommon(
	runnerCmd
		.command('daemon')
		.description('Run the local runner daemon: register/reconnect, poll for assigned runs, execute them')
		.option('--name <name>', 'runner name, unique per user (default: this hostname)')
		.option('--harness <harness>', 'claude-code | codex | custom', 'claude-code')
		.option('--command <template>', 'custom harness command template ({prompt_file}, {workspace}, {model})')
		.option('--max-concurrent <n>', 'maximum simultaneous runs', (v) => Number.parseInt(v, 10), 1)
		.option('--poll-interval <seconds>', 'seconds between polls', (v) => Number.parseInt(v, 10), 15)
).action(
	async (
		opts: CommonOpts & {
			name?: string;
			harness: string;
			command?: string;
			maxConcurrent: number;
			pollInterval: number;
		}
	) => {
		const harness = opts.harness.replaceAll('-', '_') as HarnessKind;
		if (!HARNESS_KINDS.includes(harness)) {
			die(`--harness must be claude-code, codex, or custom, got "${opts.harness}"`);
		}
		if (harness === 'custom' && !opts.command) {
			die('the custom harness needs --command "<template>" ({prompt_file}, {workspace}, {model})');
		}
		if (harness !== 'custom' && opts.command) die('--command only applies to --harness custom');
		if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1 || opts.maxConcurrent > 100) {
			die('--max-concurrent must be an integer between 1 and 100');
		}
		if (!Number.isInteger(opts.pollInterval) || opts.pollInterval < 1) {
			die('--poll-interval must be a positive number of seconds');
		}
		await runDaemon({
			url: resolveUrl(opts).replace(/\/+$/, ''),
			apiKey: resolveApiKey(opts),
			name: opts.name ?? hostname(),
			harness,
			command: opts.command,
			maxConcurrent: opts.maxConcurrent,
			pollIntervalMs: opts.pollInterval * 1000,
			configDir: defaultConfigDir()
		});
	}
);

// --- runs --------------------------------------------------------------------

const runsCmd = program.command('runs').description('Agent runs: attempts at issues by runners');

/** Run cost for a row: dollars where known, tokens where only they are, honest markers otherwise. */
function runCostLabel(run: AgentRun): string {
	const usage = run.usage;
	if (!usage) return '—';
	if (usage.cost_usd !== undefined) return `$${usage.cost_usd.toFixed(2)}`;
	if (usage.cost_source === 'none') return 'unreported';
	const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
	return tokens > 0 ? `${tokens.toLocaleString()} tok` : '—';
}

function runRow(run: AgentRun): string[] {
	return [
		run.id,
		run.issue_ref ? issueRef(run.issue_ref) : run.issue_id,
		run.runner_name,
		`${run.tier}${run.model ? ` (${run.model})` : ''}`,
		run.status,
		runDurationLabel(run),
		runCostLabel(run),
		timestamp(run.created_at)
	];
}

withList(
	runsCmd
		.command('list')
		.description('List runs, newest first')
		.option('-i, --issue <ref>', 'filter to one issue (<project>/<number>)')
		.option('-r, --runner <name>', 'filter by runner name')
		.option('--active', 'only runs holding a claim (assigned/launching/running)')
).action(async (opts: ListOpts & { issue?: string; runner?: string; active?: boolean }) => {
	const api = client(opts);
	const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
	const runnerId = opts.runner ? (await resolveRunner(api, opts.runner)).id : undefined;
	const res = await api.listRuns({
		issue: issueId,
		runner: runnerId,
		active: opts.active ? true : undefined,
		limit: opts.limit,
		cursor: opts.cursor
	});
	printList(res, opts, (items) => {
		if (items.length === 0) return console.log(opts.active ? 'no active runs' : 'no runs');
		table([['ID', 'ISSUE', 'RUNNER', 'TIER', 'STATUS', 'DURATION', 'COST', 'CREATED'], ...items.map(runRow)]);
	});
});

withCommon(
	runsCmd
		.command('show <id>')
		.description('Show a run; --logs prints the captured log tail')
		.option('--logs', 'print the log tail')
).action(async (id: string, opts: CommonOpts & { logs?: boolean }) => {
	const api = client(opts);
	const run = await api.getRun(id);
	if (opts.json) return printJson(run);
	console.log(`${run.id}  ${run.status}  on ${run.runner_name}`);
	if (run.issue_ref) console.log(`issue: ${issueRef(run.issue_ref)} — ${run.issue_ref.title}`);
	console.log(`tier: ${run.tier}  model: ${run.model ?? '(n/a)'}`);
	console.log(
		`states: ${run.state_at_start_name ?? run.state_id_at_start} → ${run.state_at_end_name ?? run.state_id_at_end ?? '…'}`
	);
	console.log(
		`created: ${timestamp(run.created_at)}  started: ${run.started_at ? timestamp(run.started_at) : '—'}  ended: ${run.ended_at ? timestamp(run.ended_at) : '—'}  duration: ${runDurationLabel(run)}`
	);
	if (run.usage) {
		const u = run.usage;
		const parts: string[] = [];
		if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
			parts.push(`${(u.input_tokens ?? 0).toLocaleString()} in / ${(u.output_tokens ?? 0).toLocaleString()} out tokens`);
		}
		if (u.cost_usd !== undefined) parts.push(`$${u.cost_usd.toFixed(2)}`);
		if (u.cost_source) parts.push(`(${u.cost_source === 'provider' ? 'provider-reported' : u.cost_source})`);
		if (parts.length > 0) console.log(`usage: ${parts.join('  ')}`);
	}
	if (run.provider_session_id) console.log(`provider session: ${run.provider_session_id}`);
	if (run.provider_url) console.log(`provider console: ${run.provider_url}`);
	if (run.error) console.log(`error: ${run.error}`);
	if (opts.logs) {
		console.log('');
		if (run.log_bytes_dropped > 0) {
			console.log(`[${Math.round(run.log_bytes_dropped / 1024)} KB truncated from the head]`);
		}
		console.log(run.log || '(no log output captured)');
	}
});

withCommon(
	runsCmd.command('cancel <id>').description('Cancel a run (judged like any other end: usually a strike)')
).action(async (id: string, opts: CommonOpts) => {
	const api = client(opts);
	const run = await api.cancelRun(id);
	if (opts.json) return printJson(run);
	console.log(
		`canceled ${run.id}${run.issue_ref ? ` on ${issueRef(run.issue_ref)}` : ''} (was on ${run.runner_name})`
	);
});

// --- routing -----------------------------------------------------------------

const routing = program
	.command('routing')
	.description('Scoped routing rules: which runner takes which issues (most specific scope wins)');

interface RoutingScopeOpts {
	project?: string;
	state?: string;
}

/** Resolves --project/--state to rule scope ids (absent = global dimension). */
async function resolveRoutingScope(
	api: ApiClient,
	opts: RoutingScopeOpts
): Promise<{ projectId: string | null; stateId: string | null; label: string }> {
	const projectId = opts.project !== undefined ? (await resolveProject(api, opts.project)).id : null;
	const stateId = opts.state !== undefined ? (await resolveStateFlag(api, opts.state)).state.id : null;
	const parts: string[] = [];
	if (opts.project) parts.push(`project ${opts.project}`);
	if (opts.state) parts.push(`state ${opts.state}`);
	return { projectId, stateId, label: parts.length > 0 ? parts.join(' · ') : 'global' };
}

function ruleTargetsLabel(rule: RoutingRule): string {
	if (rule.targets.length === 0) return '(no targets)';
	return rule.targets
		.map((t) => `${t.runner_name}${t.tier ? `:${t.tier}` : ''}${t.runner_status === 'paused' ? ' (paused)' : ''}`)
		.join(' → ');
}

withCommon(routing.command('list').description('List routing rules, most specific first')).action(
	async (opts: CommonOpts) => {
		const res = await client(opts).listRoutingRules();
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('no routing rules — nothing will dispatch');
		table([
			['SCOPE', 'TARGETS', 'ID'],
			...res.items.map((r) => [r.scope.label, ruleTargetsLabel(r), r.id])
		]);
	}
);

withCommon(
	routing
		.command('set <target...>')
		.description('Create or replace the rule at a scope: an ordered list of <runner>[:tier] targets')
		.option('-p, --project <name>', 'scope: project name or id')
		.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
).action(async (targetSpecs: string[], opts: CommonOpts & RoutingScopeOpts) => {
	const api = client(opts);
	const scope = await resolveRoutingScope(api, opts);
	const targets = [];
	for (const spec of targetSpecs) {
		const { name, tier } = parseTargetSpec(spec);
		const runner = await resolveRunner(api, name);
		targets.push(tier ? { runner_id: runner.id, tier } : { runner_id: runner.id });
	}
	// One rule per exact scope: replace the existing rule's targets, else create.
	const { items } = await api.listRoutingRules();
	const existing = items.find(
		(r) => r.scope.project_id === scope.projectId && r.scope.workflow_state_id === scope.stateId
	);
	const rule = existing
		? await api.updateRoutingRule(existing.id, { targets })
		: await api.createRoutingRule({ project_id: scope.projectId, workflow_state_id: scope.stateId, targets });
	if (opts.json) return printJson(rule);
	console.log(
		`${existing ? 'updated' : 'created'} the ${rule.scope.label} rule: ${ruleTargetsLabel(rule)}`
	);
	for (const warning of rule.warnings) console.log(`warning: ${warning.message}`);
});

withCommon(
	routing
		.command('clear')
		.description('Delete the rule at a scope (issues it matched stop dispatching)')
		.option('-p, --project <name>', 'scope: project name or id')
		.option('-s, --state <workflow/state>', 'scope: workflow-qualified state')
).action(async (opts: CommonOpts & RoutingScopeOpts) => {
	const api = client(opts);
	const scope = await resolveRoutingScope(api, opts);
	const { items } = await api.listRoutingRules();
	const existing = items.find(
		(r) => r.scope.project_id === scope.projectId && r.scope.workflow_state_id === scope.stateId
	);
	if (!existing) die(`no routing rule at scope ${scope.label}`);
	await api.deleteRoutingRule(existing.id);
	console.log(`cleared the ${existing.scope.label} rule`);
});

// --- supervisor --------------------------------------------------------------

const supervisor = program
	.command('supervisor')
	.description('The automation kill switch, quota policy, and attempt limit');

/** Human-readable policy line; state names resolved when workflows are given. */
function quotaLabel(quota: QuotaPolicy, stateName?: (id: string) => string): string {
	if (quota.type === 'global_cap') return `global cap: at most ${quota.limit} concurrent runs`;
	const overrides = Object.entries(quota.overrides).map(
		([id, limit]) => `${stateName ? stateName(id) : id}=${limit}`
	);
	return `state roster: default ${quota.default_limit} per state${overrides.length > 0 ? `, overrides: ${overrides.join(', ')}` : ''}`;
}

withCommon(supervisor.command('status').description('One-screen overview: kill switch, quota, utilization, runners')).action(
	async (opts: CommonOpts) => {
		const api = client(opts);
		const [settings, runnersRes, workflows, activeRuns] = await Promise.all([
			api.getSupervisorSettings(),
			api.listRunners(),
			api.listWorkflows({ limit: 100 }),
			api.listRuns({ active: true, limit: 100 })
		]);
		if (opts.json) {
			return printJson({ settings, runners: runnersRes.items, active_runs: activeRuns.items });
		}
		const stateNames = new Map<string, string>();
		for (const wf of workflows.items) {
			for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
		}
		console.log(`automation: ${settings.enabled ? 'ON' : 'OFF (kill switch — nothing dispatches)'}`);
		console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
		console.log(`utilization: ${utilizationLabel(settings.quota, activeRuns.items, (id) => stateNames.get(id) ?? id)}`);
		console.log(`attempt limit: ${settings.attempt_limit} strikes, then the issue parks`);
		if (runnersRes.items.length === 0) {
			console.log('runners: none');
		} else {
			console.log('runners:');
			table(
				runnersRes.items.map((r) => [
					`  ${r.name}`,
					r.type,
					runnerStatusLabel(r),
					`${r.active_runs}/${r.max_concurrent}`
				])
			);
		}
	}
);

withCommon(supervisor.command('enable').description('Arm automation (the kill switch on)')).action(
	async (opts: CommonOpts) => {
		const settings = await client(opts).updateSupervisorSettings({ enabled: true });
		if (opts.json) return printJson(settings);
		console.log('automation is ON — eligible issues with a matching rule will dispatch');
	}
);

withCommon(supervisor.command('disable').description('Pause all automation at once (the kill switch off)')).action(
	async (opts: CommonOpts) => {
		const settings = await client(opts).updateSupervisorSettings({ enabled: false });
		if (opts.json) return printJson(settings);
		console.log('automation is OFF — nothing new dispatches until re-enabled');
	}
);

const quota = supervisor.command('quota').description('Pick and configure the quota policy');

withCommon(
	quota.command('global <n>').description('Use the global cap: at most <n> concurrent runs in total')
).action(async (n: string, opts: CommonOpts) => {
	const limit = Number.parseInt(n, 10);
	const settings = await client(opts).updateSupervisorSettings({
		quota: { type: 'global_cap', limit }
	});
	if (opts.json) return printJson(settings);
	console.log(quotaLabel(settings.quota));
});

withCommon(
	quota
		.command('roster')
		.description('Use the per-state roster: at most N concurrent runs per workflow state')
		.requiredOption('--default <n>', 'limit for states without an override', (v) => Number.parseInt(v, 10))
		.option(
			'--state <workflow/state=n>',
			'per-state override (repeatable), counted by the state a run started in',
			collect,
			[]
		)
).action(async (opts: CommonOpts & { default: number; state: string[] }) => {
	const api = client(opts);
	const overrides: Record<string, number> = {};
	for (const spec of opts.state) {
		const sep = spec.lastIndexOf('=');
		if (sep < 1 || sep === spec.length - 1) {
			die(`--state must look like <workflow>/<state>=<n>, got "${spec}"`);
		}
		const limit = Number.parseInt(spec.slice(sep + 1), 10);
		const { state } = await resolveStateFlag(api, spec.slice(0, sep));
		overrides[state.id] = limit;
	}
	const settings = await api.updateSupervisorSettings({
		quota: { type: 'state_roster', default_limit: opts.default, overrides }
	});
	if (opts.json) return printJson(settings);
	const workflows = await api.listWorkflows({ limit: 100 });
	const stateNames = new Map<string, string>();
	for (const wf of workflows.items) {
		for (const s of wf.states) stateNames.set(s.id, `${wf.name}/${s.name}`);
	}
	console.log(quotaLabel(settings.quota, (id) => stateNames.get(id) ?? id));
});

// --- events ------------------------------------------------------------------

const events = program.command('events').description('Read the activity log');

withList(
	events
		.command('list')
		.description('List activity events, newest first')
		.option('-i, --issue <ref>', 'filter to one issue (<project>/<number>)')
		.option('-p, --project <name>', 'filter by project name or id')
		.option('-t, --type <type>', 'filter by event type (e.g. issue.transitioned)')
).action(async (opts: ListOpts & { issue?: string; project?: string; type?: string }) => {
	const api = client(opts);
	const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
	const res = await api.listEvents({
		issue: issueId,
		project: opts.project,
		type: opts.type,
		limit: opts.limit,
		cursor: opts.cursor
	});
	printList(res, opts, (items) => {
		if (items.length === 0) return console.log('no events');
		table([
			['WHEN', 'ACTOR', 'EVENT'],
			...items.map((ev) => [timestamp(ev.created_at), actorLabel(ev.actor), eventSummary(ev)])
		]);
	});
});

// ---------------------------------------------------------------------------

try {
	await program.parseAsync();
} catch (err) {
	reportError(err);
}
