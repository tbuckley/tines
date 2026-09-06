/** `tines projects` — the top-level container for issues, workflows, and scope. */
import { readBodyValue } from '../body-value.js';
import {
	client,
	die,
	fetchList,
	printJson,
	printList,
	resolveProject,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { timestamp } from '../format.js';
import { type UpdateProjectRequest } from '@tines/shared';
import type { Command } from 'commander';

export function register(program: Command): void {
	const projects = program.command('projects').description('Manage projects');

	withList(
		projects
			.command('list')
			.description('List projects')
			.option('--archived', 'include archived projects (hidden by default)')
	).action(async (opts: ListOpts & { archived?: boolean }) => {
		const api = client(opts);
		const res = await fetchList(opts, (page) =>
			api.listProjects({ ...page, ...(opts.archived ? { archived: 'all' as const } : {}) })
		);
		printList(res, opts, (items) => {
			if (items.length === 0) return console.log('no projects');
			// The ARCHIVED column only appears with the flag, so the default
			// output is unchanged for everyone who never archives anything.
			table([
				['NAME', 'ISSUES', 'ID', 'CREATED', ...(opts.archived ? ['ARCHIVED'] : [])],
				...items.map((p) => [
					p.name,
					String(p.issue_count),
					p.id,
					timestamp(p.created_at),
					...(opts.archived ? [p.archived_at ? timestamp(p.archived_at) : '-'] : [])
				])
			]);
		});
	});

	withCommon(
		projects
			.command('create <name>')
			.description('Create a project (with its initial context prompt)')
			.option('-d, --description <text>', 'project description')
			.option('-w, --default-workflow <id-or-name>', 'default workflow for new issues')
			.option(
				'--prompt <md>',
				"initial conventions prompt, stitched into every issue's agent prompt: inline Markdown or @file"
			)
			.option('--no-prompt', 'create without an initial prompt')
	).action(
		async (
			name: string,
			opts: CommonOpts & {
				description?: string;
				defaultWorkflow?: string;
				prompt?: string | boolean;
			}
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
			if (project.archived_at !== null) console.log(`archived: ${timestamp(project.archived_at)}`);
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
			.command('archive <id-or-name>')
			.description(
				'Archive a project: pause its schedules, stop dispatch, make its issues read-only'
			)
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await resolveProject(api, ref);
		const res = await api.archiveProject(project.id);
		if (opts.json) return printJson(res);
		// Archiving drains: runs already under way finish on their own issue.
		const draining = res.draining_runs.length
			? `${res.draining_runs.length} run${res.draining_runs.length === 1 ? '' : 's'} draining (` +
				res.draining_runs
					.map((r) => `${r.runner_name} on ${res.project.name}/${r.issue_number}`)
					.join(', ') +
				')'
			: '0 runs draining';
		console.log(
			`archived project "${res.project.name}" (${res.project.id}): ` +
				`${res.schedules_paused} schedule${res.schedules_paused === 1 ? '' : 's'} paused, ` +
				`${draining}, ${res.issues_read_only} issue${res.issues_read_only === 1 ? '' : 's'} read-only`
		);
	});

	withCommon(
		projects
			.command('unarchive <id-or-name>')
			.description('Unarchive a project: schedules resume from their next occurrence')
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await resolveProject(api, ref);
		const res = await api.unarchiveProject(project.id);
		if (opts.json) return printJson(res);
		console.log(
			`unarchived project "${res.project.name}" (${res.project.id}): ` +
				`${res.schedules_resumed} schedule${res.schedules_resumed === 1 ? '' : 's'} resumed`
		);
	});

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
}
