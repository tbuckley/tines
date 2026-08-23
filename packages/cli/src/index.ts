import {
	ApiError,
	createApiClient,
	type ApiClient,
	type IssueDetail,
	type Project,
	type StateCategory,
	type TinesEvent,
	type WorkflowResponse
} from '@tines/shared';
import { Command } from 'commander';

const DEFAULT_URL = process.env.TINES_API_URL ?? 'http://localhost:5173';

interface CommonOpts {
	url: string;
	apiKey?: string;
	json?: boolean;
}

/** Adds the options shared by every command (after the subcommand name). */
function withCommon(cmd: Command): Command {
	return cmd
		.option('-u, --url <url>', 'base URL of the Tines API (or set TINES_API_URL)', DEFAULT_URL)
		.option('--api-key <key>', 'API key (or set TINES_API_KEY)', process.env.TINES_API_KEY)
		.option('--json', 'output the raw JSON response');
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
			const names = allowed.map((s) => (s as { name: string }).name);
			message +=
				names.length > 0
					? `\nallowed transitions: ${names.join(', ')}`
					: '\nallowed transitions: none (terminal state)';
		}
		die(message);
	}
	die(err instanceof Error ? err.message : String(err));
}

function printJson(value: unknown): void {
	console.log(JSON.stringify(value, null, 2));
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
	const allowed = issue.allowed_transitions.map((s) => s.name);
	console.log(`\nallowed transitions: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`);
	if (issue.comments.length > 0) {
		console.log(`\ncomments (${issue.comments.length}):`);
		for (const c of issue.comments) {
			console.log(`\n  [${timestamp(c.created_at)}] ${actorLabel(c.actor)}:`);
			for (const line of c.body.split('\n')) console.log(`  ${line}`);
		}
	}
}

function eventSummary(ev: TinesEvent): string {
	const p = ev.payload as Record<string, unknown>;
	const issue = ev.issue_ref ? `${ev.issue_ref.project_name}/#${ev.issue_ref.number}` : null;
	switch (ev.type) {
		case 'issue.created':
			return `created ${issue}: ${p.title}`;
		case 'issue.updated':
			return `updated ${issue} (${(p.changed as string[])?.join(', ')})`;
		case 'issue.transitioned':
			return `moved ${issue}: ${p.from_state_name} → ${p.to_state_name}`;
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

withCommon(projects.command('list').description('List projects')).action(
	async (opts: CommonOpts) => {
		const { items } = await client(opts).listProjects();
		if (opts.json) return printJson(items);
		if (items.length === 0) return console.log('no projects');
		table([
			['NAME', 'ISSUES', 'ID', 'CREATED'],
			...items.map((p) => [p.name, String(p.issue_count), p.id, timestamp(p.created_at)])
		]);
	}
);

withCommon(
	projects
		.command('create <name>')
		.description('Create a project')
		.option('-d, --description <text>', 'project description')
).action(async (name: string, opts: CommonOpts & { description?: string }) => {
	const project = await client(opts).createProject({ name, description: opts.description });
	if (opts.json) return printJson(project);
	console.log(`created project "${project.name}" (${project.id})`);
});

// --- workflows ---------------------------------------------------------------

const workflows = program.command('workflows').description('Inspect the workflow library');

withCommon(workflows.command('list').description('List the workflow library')).action(
	async (opts: CommonOpts) => {
		const { items } = await client(opts).listWorkflows();
		if (opts.json) return printJson(items);
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
	}
);

withCommon(
	workflows.command('show <id-or-name>').description('Show a workflow with states and transitions')
).action(async (ref: string, opts: CommonOpts) => {
	const api = client(opts);
	const wf = await resolveWorkflow(api, ref);
	if (opts.json) return printJson(wf);
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
		console.log(`  ${byId.get(t.from_state_id)?.name} → ${byId.get(t.to_state_id)?.name}`);
	}
	for (const w of wf.warnings ?? []) console.log(`\nwarning: ${w}`);
});

// --- issues ------------------------------------------------------------------

const issues = program.command('issues').description('Work with issues');

withCommon(
	issues
		.command('list')
		.description('List issues across projects (hides done issues unless --all)')
		.option('-p, --project <name>', 'filter by project name or id')
		.option('-s, --state <name>', 'filter by state name or id')
		.option('-c, --category <cat>', 'filter by state category')
		.option('-a, --all', 'include issues in done states')
		.option('--limit <n>', 'maximum issues to return', (v) => Number.parseInt(v, 10))
).action(
	async (
		opts: CommonOpts & {
			project?: string;
			state?: string;
			category?: StateCategory;
			all?: boolean;
			limit?: number;
		}
	) => {
		const { items } = await client(opts).listIssues({
			project: opts.project,
			state: opts.state,
			category: opts.category,
			hide_done: !opts.all,
			limit: opts.limit
		});
		if (opts.json) return printJson(items);
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
	}
);

withCommon(
	issues
		.command('create <project>')
		.description('Create an issue in a project')
		.requiredOption('-t, --title <title>', 'issue title')
		.option('-d, --description <markdown>', 'issue description (Markdown)')
		.option('-w, --workflow <id-or-name>', 'workflow (defaults to project default, else standard)')
).action(
	async (
		projectRef: string,
		opts: CommonOpts & { title: string; description?: string; workflow?: string }
	) => {
		const api = client(opts);
		const project = await resolveProject(api, projectRef);
		const workflowId = opts.workflow ? (await resolveWorkflow(api, opts.workflow)).id : undefined;
		const issue = await api.createIssue(project.id, {
			title: opts.title,
			description: opts.description,
			workflow_id: workflowId
		});
		if (opts.json) return printJson(issue);
		console.log(
			`created ${issue.project_name}/#${issue.number} "${issue.title}" in state "${issue.state.name}"`
		);
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
	issues.command('move <ref> <state>').description('Move an issue to a state (by state name)')
).action(async (ref: string, stateName: string, opts: CommonOpts) => {
	const api = client(opts);
	const issue = await resolveIssue(api, ref);
	const target =
		issue.workflow.states.find((s) => s.name === stateName) ??
		issue.workflow.states.find((s) => s.id === stateName);
	if (!target) {
		die(
			`workflow "${issue.workflow.name}" has no state "${stateName}" (states: ${issue.workflow.states.map((s) => s.name).join(', ')})`
		);
	}
	const moved = await api.transitionIssue(issue.id, { to_state_id: target.id });
	if (opts.json) return printJson(moved);
	console.log(`${moved.project_name}/#${moved.number}: ${issue.state.name} → ${moved.state.name}`);
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

// --- events ------------------------------------------------------------------

const events = program.command('events').description('Read the activity log');

withCommon(
	events
		.command('list')
		.description('List activity events, newest first')
		.option('-i, --issue <ref>', 'filter to one issue (<project>/<number>)')
		.option('-p, --project <name>', 'filter by project name or id')
		.option('-t, --type <type>', 'filter by event type (e.g. issue.transitioned)')
		.option('--limit <n>', 'maximum events to return', (v) => Number.parseInt(v, 10))
).action(
	async (
		opts: CommonOpts & { issue?: string; project?: string; type?: string; limit?: number }
	) => {
		const api = client(opts);
		const issueId = opts.issue ? (await resolveIssue(api, opts.issue)).id : undefined;
		const { items } = await api.listEvents({
			issue: issueId,
			project: opts.project,
			type: opts.type,
			limit: opts.limit
		});
		if (opts.json) return printJson(items);
		if (items.length === 0) return console.log('no events');
		table([
			['WHEN', 'ACTOR', 'EVENT'],
			...items.map((ev) => [timestamp(ev.created_at), actorLabel(ev.actor), eventSummary(ev)])
		]);
	}
);

// ---------------------------------------------------------------------------

try {
	await program.parseAsync();
} catch (err) {
	reportError(err);
}
