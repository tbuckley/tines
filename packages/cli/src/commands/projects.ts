/** `tines projects` — the top-level container for issues, workflows, and scope. */
import { readBodyValue } from '../body-value.js';
import {
	client,
	die,
	fetchList,
	printJson,
	printList,
	resolveUrl,
	resolveProject,
	resolveWorkflow,
	table,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { timestamp } from '../format.js';
import {
	type CreateProjectRequest,
	type StarterInputSpec,
	type StarterSummary,
	type UpdateProjectRequest
} from '@tines/shared';
import type { Command } from 'commander';

export function register(program: Command): void {
	const projects = program.command('projects').description('Manage projects');

	withCommon(
		projects.command('starters').description('List built-in project starters and their inputs')
	).action(async (opts: CommonOpts) => {
		const response = await client(opts).listStarters();
		if (opts.json) return printJson(response);
		for (const starter of response.items) {
			console.log(`${starter.id} — ${starter.name}`);
			console.log(`  ${starter.description}`);
			for (const input of starter.inputs) {
				console.log(
					`  --${inputFlag(input)}${input.required ? ' (required)' : ' (optional)'} — ${input.description ?? input.label}`
				);
			}
			for (const workflow of starter.creates.workflows) {
				console.log(
					`  workflow: ${workflow.name}${workflow.default ? ' (default)' : ''} — ${workflow.states.join(' → ')}`
				);
			}
			for (const item of starter.creates.context) console.log(`  ${item.kind}: ${item.name}`);
			if (starter.creates.first_issue) {
				const issue = starter.creates.first_issue;
				console.log(`  first issue: ${issue.title} — ${issue.state} (${issue.workflow})`);
			}
			if (isBlank(starter)) console.log('  requires --prompt or --no-prompt when creating');
		}
	});

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
			.description(
				'Create a project; nonblank starters supply a conventions template unless --prompt or --no-prompt overrides it'
			)
			.option('-d, --description <text>', 'project description')
			.option(
				'-w, --default-workflow <id-or-name>',
				'default workflow for new issues (conflicts with a starter that sets one)'
			)
			.option('--starter <id>', 'built-in starter (discover with `tines projects starters`)')
			.option('--repo <url>', 'repository URL for the code starter')
			.option('--branch <branch>', 'repository branch for the code starter')
			.option('--brief <text>', 'planning brief for the plan starter')
			.option(
				'--prompt <md>',
				"override the starter's conventions template: inline Markdown or @file"
			)
			.option(
				'--no-prompt',
				"omit the starter's conventions template (other starter context remains)"
			)
	).action(
		async (
			name: string,
			opts: CommonOpts & {
				description?: string;
				defaultWorkflow?: string;
				starter?: string;
				repo?: string;
				branch?: string;
				brief?: string;
				prompt?: string | boolean;
			}
		) => {
			const prompt = typeof opts.prompt === 'string' ? readBodyValue(opts.prompt) : undefined;
			const suppliedInputs = [
				['repo_url', '--repo', opts.repo],
				['repo_branch', '--branch', opts.branch],
				['brief', '--brief', opts.brief]
			] as const;
			if (!opts.starter && suppliedInputs.some(([, , value]) => value !== undefined)) {
				die(
					'starter input flags require --starter (discover choices with `tines projects starters`)'
				);
			}
			const api = client(opts);
			let starter: StarterSummary | undefined;
			let starterRequest: CreateProjectRequest['starter'];
			if (opts.starter) {
				const response = await api.listStarters();
				starter = response.items.find((item) => item.id === opts.starter);
				if (!starter) {
					die(
						`unknown starter "${opts.starter}"; choose ${response.items.map((item) => item.id).join(', ')} (see \`tines projects starters\`)`
					);
				}
				const declared = new Map(starter.inputs.map((input) => [input.key, input]));
				for (const [key, flag, value] of suppliedInputs) {
					if (value !== undefined && !declared.has(key))
						die(`${flag} is not used by starter "${starter.id}"`);
				}
				const inputs: Record<string, string> = {};
				for (const [key, , value] of suppliedInputs) {
					if (value !== undefined && declared.has(key)) inputs[key] = value.trim();
				}
				for (const input of starter.inputs) {
					const value = inputs[input.key] ?? '';
					if (input.required && !value)
						die(`starter "${starter.id}" requires --${inputFlag(input)}`);
					const max = input.max ?? 10_000;
					if (value.length > max) die(`--${inputFlag(input)} is longer than ${max} characters`);
				}
				if (
					starter.creates.workflows.some((workflow) => workflow.default) &&
					opts.defaultWorkflow
				) {
					die(`starter "${starter.id}" sets the default workflow; do not pass --default-workflow`);
				}
				starterRequest = { id: starter.id, inputs };
			}
			// Every issue in a project inherits its context, so the CLI insists on
			// an explicit choice for Blank; nonblank starters supply a template.
			if ((!starter || isBlank(starter)) && (opts.prompt === undefined || opts.prompt === true)) {
				die(
					'every issue in a project inherits its context — give the project an initial prompt:\n' +
						'  --prompt "<markdown>"   house conventions, inline or @file\n' +
						'  --no-prompt             create without one (add later: tines context create -k prompt -n conventions -p <name> --body …)'
				);
			}
			const workflowId = opts.defaultWorkflow
				? (await resolveWorkflow(api, opts.defaultWorkflow)).id
				: undefined;
			const body: CreateProjectRequest = {
				name,
				description: opts.description,
				default_workflow_id: workflowId,
				...(typeof opts.prompt === 'string'
					? { initial_prompt: prompt }
					: opts.prompt === false
						? { initial_prompt: '' }
						: {}),
				...(starterRequest ? { starter: starterRequest } : {})
			};
			const project = await api.createProject(body);
			if (opts.json) return printJson(project);
			console.log(
				`created project "${project.name}" (${project.id})${typeof opts.prompt === 'string' ? ' with its "conventions" prompt' : ''}`
			);
			if (project.starter) {
				for (const workflow of project.starter.workflows) {
					console.log(
						`workflow: ${workflow.name} (${workflow.id})${workflow.reused ? ' — reused' : ''}`
					);
				}
				for (const item of project.starter.context)
					console.log(`context: ${item.kind} “${item.name}”`);
				if (project.starter.first_issue) {
					const issue = project.starter.first_issue;
					console.log(`first issue: ${issue.ref} — ${issue.state_name}`);
					console.log(`tines issues show "${issue.ref}"`);
				}
				console.log(`Next: get an agent running — ${resolveUrl(opts).replace(/\/$/, '')}/agents`);
			}
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

function inputFlag(input: StarterInputSpec): string {
	if (input.key === 'repo_url') return 'repo';
	if (input.key === 'repo_branch') return 'branch';
	return input.key.replaceAll('_', '-');
}

function isBlank(starter: StarterSummary): boolean {
	return (
		starter.creates.workflows.length === 0 &&
		starter.creates.context.length === 0 &&
		starter.creates.first_issue === null
	);
}
