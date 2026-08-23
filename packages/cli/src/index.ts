import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
	ApiError,
	createApiClient,
	describeRecurrence,
	WEEKDAY_NAMES,
	type ApiClient,
	type CreateScheduleInput,
	type CreateWorkflowRequest,
	type IssueDetail,
	type ListResponse,
	type Project,
	type Schedule,
	type SchedulePreset,
	type StateCategory,
	type TinesEvent,
	type UpdateIssueRequest,
	type UpdateProjectRequest,
	type UpdateScheduleRequest,
	type UpdateWorkflowRequest,
	type WorkflowResponse
} from '@tines/shared';
import { Command } from 'commander';

const DEFAULT_URL = process.env.TINES_API_URL ?? 'http://localhost:5173';

interface CommonOpts {
	url: string;
	apiKey?: string;
	json?: boolean;
}

interface ListOpts extends CommonOpts {
	limit?: number;
	cursor?: string;
}

/** Adds the options shared by every command (after the subcommand name). */
function withCommon(cmd: Command): Command {
	return cmd
		.option('-u, --url <url>', 'base URL of the Tines API (or set TINES_API_URL)', DEFAULT_URL)
		.option('--api-key <key>', 'API key (or set TINES_API_KEY)', process.env.TINES_API_KEY)
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

function client(opts: CommonOpts): ApiClient {
	return createApiClient({ baseUrl: opts.url, apiKey: opts.apiKey });
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

function actorLabel(actor: { user_name: string; api_key_name: string | null }): string {
	return actor.api_key_name ? `${actor.user_name} via ${actor.api_key_name}` : actor.user_name;
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

const WORKFLOW_JSON_HELP = `
The JSON body may be passed inline, via --file <path>, --file - (stdin), or
piped on stdin. Shape:

  {
    "name": "Review",
    "description": "Two-step review",
    "initial_state": "Draft",
    "states": [
      { "name": "Draft", "category": "active" },
      { "name": "In review", "category": "awaiting_human" },
      { "name": "Done", "category": "done" }
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
	if (opts.every === undefined) die('--at/--on set a preset time; add --every <daily|weekly|monthly>');
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
			die(`--every must be daily, weekly, or monthly, got "${opts.every}"`);
	}
}

function recurrenceLabel(schedule: Schedule): string {
	return `${describeRecurrence(schedule.preset, schedule.cron)}, ${schedule.timezone}`;
}

// ---------------------------------------------------------------------------
// Output helpers

function printIssueDetail(issue: IssueDetail): void {
	console.log(`${issue.project_name}/#${issue.number}  ${issue.title}`);
	console.log(
		`state: ${issue.state.name} (${issue.state.category})  workflow: ${issue.workflow.name}  updated: ${timestamp(issue.updated_at)}`
	);
	console.log(`id: ${issue.id}`);
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
		case 'scheduled_task.skipped': {
			const blocking = Array.isArray(p.blocking) ? p.blocking.length : 0;
			return `skipped schedule "${p.name}" (${blocking} open instance${blocking === 1 ? '' : 's'})`;
		}
		default:
			return ev.type;
	}
}

// ---------------------------------------------------------------------------
// Program

const program = new Command();
program.name('tines').description('CLI for Tines').version('0.0.1');

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
		.description('Create a project')
		.option('-d, --description <text>', 'project description')
		.option('-w, --default-workflow <id-or-name>', 'default workflow for new issues')
).action(
	async (name: string, opts: CommonOpts & { description?: string; defaultWorkflow?: string }) => {
		const api = client(opts);
		const workflowId = opts.defaultWorkflow
			? (await resolveWorkflow(api, opts.defaultWorkflow)).id
			: undefined;
		const project = await api.createProject({
			name,
			description: opts.description,
			default_workflow_id: workflowId
		});
		if (opts.json) return printJson(project);
		console.log(`created project "${project.name}" (${project.id})`);
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
		.description('Create a workflow from a JSON definition')
		.option('-f, --file <path>', 'read the JSON definition from a file ("-" for stdin)')
		.addHelpText('after', WORKFLOW_JSON_HELP)
).action(async (inline: string | undefined, opts: CommonOpts & { file?: string }) => {
	const body = readJsonBody(inline, opts.file);
	if (!body) {
		die(
			'missing workflow JSON: pass it inline, with --file <path>, or pipe it on stdin' +
				`\nsee \`tines workflows create --help\` for the expected shape`
		);
	}
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
		.addHelpText('after', WORKFLOW_JSON_HELP)
).action(
	async (
		ref: string,
		inline: string | undefined,
		opts: CommonOpts & { file?: string; name?: string; description?: string; initialState?: string }
	) => {
		const api = client(opts);
		const wf = await resolveWorkflow(api, ref);
		const body = (readJsonBody(inline, opts.file) ?? {}) as UpdateWorkflowRequest;
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
).action(
	async (
		opts: ListOpts & {
			project?: string;
			state?: string;
			category?: StateCategory;
			workflow?: string;
			all?: boolean;
		}
	) => {
		const res = await client(opts).listIssues({
			project: opts.project,
			state: opts.state,
			category: opts.category,
			workflow: opts.workflow,
			hide_done: !opts.all,
			limit: opts.limit,
			cursor: opts.cursor
		});
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log('no issues');
			table([
				['REF', 'TITLE', 'STATE', 'CATEGORY', 'LAST ACTIVITY'],
				...items.map((i) => [
					`${i.project_name}/${i.number}`,
					i.title,
					i.state.name,
					i.state.category,
					timestamp(i.last_activity_at)
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
		.option('--every <preset>', 'repeat daily, weekly, or monthly')
		.option('--at <HH:MM>', 'preset time of day (24-hour; defaults to 09:00)')
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
	issues.command('comment <ref> <markdown>').description('Comment on an issue (Markdown body)')
).action(async (ref: string, markdown: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const comment = await api.createComment(issue.id, { body: markdown });
	if (opts.json) return printJson(comment);
	console.log(`commented on ${issue.project_name}/#${issue.number} as ${actorLabel(comment.actor)}`);
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
		`gate: ${s.require_all_closed ? 'only create when previous instances are closed' : 'off'}  workflow: ${s.workflow_name}`
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
		.description('Edit a schedule: templates, recurrence, timezone, gate, or name')
		.option('-t, --title <template>', 'set the title template')
		.option('-d, --description <markdown>', 'set the description template (Markdown)')
		.option('--every <preset>', 'repeat daily, weekly, or monthly')
		.option('--at <HH:MM>', 'preset time of day (24-hour; defaults to 09:00)')
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
			RecurrenceOpts & { title?: string; description?: string; ifClosed?: boolean; name?: string }
	) => {
		const api = client(opts);
		const schedule = await resolveSchedule(api, ref);
		const body: UpdateScheduleRequest = {};
		if (opts.title !== undefined) body.title_template = opts.title;
		if (opts.description !== undefined) body.description_template = opts.description;
		const recurrence = buildRecurrence(opts);
		if (recurrence?.preset) body.preset = recurrence.preset as SchedulePreset;
		if (recurrence?.cron !== undefined) body.cron = recurrence.cron;
		if (opts.tz !== undefined) body.timezone = opts.tz;
		if (opts.ifClosed !== undefined) body.require_all_closed = opts.ifClosed;
		if (opts.name !== undefined) body.name = opts.name;
		if (Object.keys(body).length === 0) {
			die(
				'nothing to update: pass --title, --description, --every/--at/--on, --cron, --tz, --[no-]if-closed, and/or --name'
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
