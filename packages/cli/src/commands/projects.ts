/** `tines projects` — the top-level container for issues, workflows, and scope. */
import { readBodyValue } from '../body-value.js';
import {
	client,
	die,
	fetchList,
	orgLabel,
	printJson,
	printList,
	resolveOrganization,
	resolveUrl,
	resolveProject,
	resolveIssue,
	resolveWorkflow,
	table,
	webUrl,
	withCommon,
	withList,
	type CommonOpts,
	type ListOpts
} from '../common.js';
import { formatMovePreview, timestamp } from '../format.js';
import {
	type ApiClient,
	type CreateProjectRequest,
	type StarterInputSpec,
	type StarterSummary,
	type UpdateProjectRequest
} from '@tines/shared';
import type { Command } from 'commander';

const ORG_FLAG_HELP = 'look the project up in this organization only (names repeat across them)';

/** `--org <org>`: names are unique within an organization, not across them. */
function withOrg(cmd: Command): Command {
	return cmd.option('--org <org>', ORG_FLAG_HELP);
}

/** Resolves `<project>`, within `--org` when given. */
async function projectFor(api: ApiClient, ref: string, opts: CommonOpts & { org?: string }) {
	const orgId = opts.org ? (await resolveOrganization(api, opts.org)).id : undefined;
	return resolveProject(api, ref, orgId);
}

export function register(program: Command): void {
	const projects = program.command('projects').description('Manage projects');

	withCommon(
		withOrg(projects.command('people <project>').description('List the owner and active members'))
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts),
			people = await api.getProjectPeople(project.id);
		if (opts.json) return printJson(people);
		console.log(`${people.owner.name} [${people.owner.id}] — owner`);
		for (const person of people.members)
			console.log(`${person.name} [${person.id}] — member (revision ${person.revision})`);
	});
	withCommon(
		withOrg(
			projects
				.command('invite <project> <email>')
				.description('Invite someone to the whole project')
				.option('--issue <ref>', 'issue to open after acceptance')
				.option(
					'--confirm-sharing',
					'acknowledge that first sharing gives members the whole project and restarts assigned work'
				)
		)
	).action(
		async (
			ref: string,
			email: string,
			opts: CommonOpts & { issue?: string; confirmSharing?: boolean }
		) => {
			const api = client(opts),
				project = await projectFor(api, ref, opts);
			if (project.shared_at == null && !opts.confirmSharing)
				die(
					'First sharing gives access to the whole project. Your agents keep working on its issues and schedules unless you turn them off in the browser; members need their own permission. Assigned work is restarted and admitted work may finish. Rerun with --confirm-sharing to send the invite.'
				);
			const issue = opts.issue ? await resolveIssue(api, opts.issue) : null;
			if (issue && issue.project_id !== project.id)
				die('--issue must name an issue in the invited project');
			const result = await api.inviteProjectPerson(project.id, {
				email,
				...(issue ? { landing_issue_id: issue.id } : {}),
				confirm_sharing: opts.confirmSharing,
				expected_sharing_revision: project.sharing_revision ?? 0
			});
			if (opts.json) return printJson(result);
			console.log(
				`${result.delivery_status === 'sent' ? 'Invited' : 'Invitation saved; delivery failed for'} ${result.email} [${result.id}]`
			);
		}
	);
	withCommon(
		withOrg(
			projects
				.command('invite-resend <project> <invite-id>')
				.description('Rotate and resend an invitation')
		)
	).action(async (ref: string, inviteId: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts);
		const invite = (await api.listProjectInvitations(project.id)).items.find(
			(item) => item.id === inviteId
		);
		if (!invite) die('No such invitation in this project');
		const result = await api.resendProjectInvitation(project.id, inviteId, invite.generation);
		if (opts.json) return printJson(result);
		console.log(`Invitation ${inviteId} rotated; delivery ${result.delivery_status}`);
	});
	withCommon(
		withOrg(
			projects.command('invite-cancel <project> <invite-id>').description('Cancel an invitation')
		)
	).action(async (ref: string, inviteId: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts);
		const invite = (await api.listProjectInvitations(project.id)).items.find(
			(item) => item.id === inviteId
		);
		if (!invite) die('No such invitation in this project');
		await api.cancelProjectInvitation(project.id, inviteId, invite.generation);
		if (opts.json) return printJson({ canceled: true, id: inviteId });
		console.log(`Canceled invitation ${inviteId}`);
	});
	withCommon(
		withOrg(
			projects.command('remove-member <project> <user-id>').description('Remove a project member')
		)
	).action(async (ref: string, userId: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts);
		const member = (await api.getProjectPeople(project.id)).members.find(
			(person) => person.id === userId
		);
		if (!member) die('No active member has that user ID');
		const result = await api.removeProjectMember(project.id, userId, member.revision);
		if (opts.json) return printJson(result);
		console.log(`Removed ${member.name} from ${project.name}`);
	});
	withCommon(
		withOrg(projects.command('leave <project>').description('Leave a shared project'))
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts);
		const people = await api.getProjectPeople(project.id);
		// The server enforces the actor identity; the CLI only needs the current revision.
		const revision = people.members.find((person) => person.id === people.viewer_id)?.revision;
		if (!revision) die('No active membership to leave');
		const result = await api.leaveProject(project.id, revision);
		if (opts.json) return printJson(result);
		console.log(`Left ${project.name}`);
	});

	const guidance = projects
		.command('guidance')
		.description("Manage library items included in a shared project's guidance");
	withCommon(
		withOrg(
			guidance.command('list <project>').description("List a project's included library items")
		)
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts),
			res = await api.listGuidanceInclusions(project.id);
		if (opts.json) return printJson(res);
		if (res.items.length === 0) return console.log('No library items included');
		table([
			['KIND', 'NAME', 'SCOPE', 'ID'],
			...res.items.map((item) => [item.kind, item.name, item.scope_label, item.item_id])
		]);
	});
	withCommon(
		withOrg(
			guidance
				.command('include <project> <item-id>')
				.description("Include a library item in a project's shared guidance")
		)
	).action(async (ref: string, itemId: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts),
			item = await api.includeGuidanceItem(project.id, itemId);
		if (opts.json) return printJson(item);
		console.log(
			`Included ${item.kind} ${item.name} in ${project.name}'s shared guidance. Everyone in this project and their agents can read it; future edits stay shared.`
		);
	});
	withCommon(
		withOrg(
			guidance
				.command('exclude <project> <item-id>')
				.description("Remove a library item from a project's shared guidance")
		)
	).action(async (ref: string, itemId: string, opts: CommonOpts) => {
		const api = client(opts),
			project = await projectFor(api, ref, opts),
			item = await api.excludeGuidanceItem(project.id, itemId);
		if (opts.json) return printJson(item);
		console.log(`Removed ${item.kind} ${item.name} from ${project.name}'s shared guidance.`);
	});

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
			.option('--org <org>', 'only projects in this organization (filters the fetched page)')
	).action(async (opts: ListOpts & { archived?: boolean; org?: string }) => {
		const api = client(opts);
		const org = opts.org ? await resolveOrganization(api, opts.org) : undefined;
		const fetched = await fetchList(opts, (page) =>
			api.listProjects({ ...page, ...(opts.archived ? { archived: 'all' as const } : {}) })
		);
		// The API has no organization filter; this one is applied to what was
		// fetched, so without --all-pages it narrows one page.
		const res = org
			? { ...fetched, items: fetched.items.filter((p) => p.organization?.id === org.id) }
			: fetched;
		printList(res, opts, (items) => {
			if (items.length === 0)
				return console.log(org ? `no projects in ${org.name}` : 'no projects');
			// The ARCHIVED column only appears with the flag, so the default
			// output is unchanged for everyone who never archives anything.
			table([
				['NAME', 'ORGANIZATION', 'ISSUES', 'ID', 'CREATED', ...(opts.archived ? ['ARCHIVED'] : [])],
				...items.map((p) => [
					p.name,
					p.organization ? orgLabel(p.organization) : '-',
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
			.option(
				'--org <org>',
				'organization to create it in (default: your personal one; see `tines orgs list`)'
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
				org?: string;
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
			const org = opts.org ? await resolveOrganization(api, opts.org) : undefined;
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
				...(org ? { organization_id: org.id } : {}),
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
				`created project "${project.name}" (${project.id})${org ? ` in ${org.name}` : ''}${typeof opts.prompt === 'string' ? ' with its "conventions" prompt' : ''}`
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

	withCommon(withOrg(projects.command('show <id-or-name>').description('Show a project'))).action(
		async (ref: string, opts: CommonOpts) => {
			const api = client(opts);
			const project = await projectFor(api, ref, opts);
			if (opts.json) return printJson(project);
			console.log(`${project.name}  [${project.id}]`);
			if (project.organization)
				console.log(`organization: ${orgLabel(project.organization)} [${project.organization.id}]`);
			if (project.viewer_role === 'member')
				console.log(`shared by ${project.owner?.name ?? 'project owner'} — read only`);
			if (project.description) console.log(project.description);
			const defaultWorkflow =
				project.viewer_role === 'member'
					? null
					: project.default_workflow_id
						? (await api.getWorkflow(project.default_workflow_id)).name
						: '(standard)';
			if (defaultWorkflow) console.log(`\ndefault workflow: ${defaultWorkflow}`);
			console.log(
				`issues: ${project.issue_count}  created: ${timestamp(project.created_at)}  updated: ${timestamp(project.updated_at)}`
			);
			if (project.archived_at !== null) console.log(`archived: ${timestamp(project.archived_at)}`);
		}
	);

	withCommon(
		withOrg(
			projects
				.command('edit <id-or-name>')
				.description('Edit a project')
				.option('-n, --name <name>', 'rename the project')
				.option('-d, --description <text>', 'set the description')
				.option('-w, --default-workflow <id-or-name>', 'set the default workflow for new issues')
				.option('--no-default-workflow', 'clear the default workflow (fall back to standard)')
		)
	).action(
		async (
			ref: string,
			opts: CommonOpts & { name?: string; description?: string; defaultWorkflow?: string | false }
		) => {
			const api = client(opts);
			const project = await projectFor(api, ref, opts);
			const body: UpdateProjectRequest = {};
			if (opts.name !== undefined) body.name = opts.name;
			if (opts.description !== undefined) body.description = opts.description;
			if (opts.defaultWorkflow === false) body.default_workflow_id = null;
			else if (opts.defaultWorkflow !== undefined) {
				body.default_workflow_id = (
					await resolveWorkflow(api, opts.defaultWorkflow, project.id)
				).id;
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
		withOrg(
			projects
				.command('archive <id-or-name>')
				.description(
					'Archive a project: pause its schedules, stop dispatch, make its issues read-only'
				)
		)
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await projectFor(api, ref, opts);
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
		withOrg(
			projects
				.command('unarchive <id-or-name>')
				.description('Unarchive a project: schedules resume from their next occurrence')
		)
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await projectFor(api, ref, opts);
		const res = await api.unarchiveProject(project.id);
		if (opts.json) return printJson(res);
		console.log(
			`unarchived project "${res.project.name}" (${res.project.id}): ` +
				`${res.schedules_resumed} schedule${res.schedules_resumed === 1 ? '' : 's'} resumed`
		);
	});

	withCommon(
		withOrg(
			projects
				.command('move <project> <org>')
				.description(
					'Preview moving a project to another organization; the move itself is confirmed in the browser'
				)
		)
	).action(async (ref: string, orgRef: string, opts: CommonOpts & { org?: string }) => {
		const api = client(opts);
		const project = await projectFor(api, ref, opts);
		const to = await resolveOrganization(api, orgRef);
		// Only the preview is fetched: the API refuses keys a move
		// (session_required), so there is nothing here to confirm.
		const preview = await api.previewProjectMove(project.id, to.id);
		if (opts.json) return printJson(preview);
		console.log(formatMovePreview(preview));
		console.log(
			`\nTo move it, open ${webUrl(opts, `/projects/${project.id}`)} in the browser and choose Move` +
				' (moving a project needs your browser session; API keys cannot confirm it).'
		);
	});

	withCommon(
		withOrg(
			projects
				.command('share <project>')
				.description(
					'Share this project: a new shared organization with the project moved in — browser only; prints where'
				)
		)
	).action(async (ref: string, opts: CommonOpts & { org?: string }) => {
		const api = client(opts);
		const project = await projectFor(api, ref, opts);
		if (project.organization?.kind === 'shared')
			die(
				`"${project.name}" is already in the shared organization ${project.organization.name}; invite people with \`tines orgs invite ${project.organization.id} <email>\``
			);
		die(
			`sharing a project needs your browser session (API keys are refused): open ${webUrl(opts, `/projects/${project.id}`)} and choose Share`
		);
	});

	withCommon(
		withOrg(
			projects
				.command('delete <id-or-name>')
				.description('Delete a project (refused while it still contains issues)')
		)
	).action(async (ref: string, opts: CommonOpts) => {
		const api = client(opts);
		const project = await projectFor(api, ref, opts);
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
