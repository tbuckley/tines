import {
	FULL_API_KEY_PERMISSIONS,
	PROJECT_AUTOMATION_API_KEY_PERMISSIONS,
	READ_ONLY_API_KEY_PERMISSIONS,
	RUNNER_SETUP_API_KEY_PERMISSIONS,
	ApiError,
	parseApiKeyPermissions,
	type ApiClient,
	type ApiKey,
	type ApiKeyPermissions,
	type RunKeyFilter
} from '@tines/shared';
import { Option, type Command } from 'commander';
import { readBodyValue } from '../body-value.js';
import {
	client,
	die,
	printJson,
	resolveOrganization,
	table,
	withCommon,
	type CommonOpts
} from '../common.js';
import { runScopeLabel } from '../format.js';

type Preset = 'full' | 'read-only' | 'project-automation' | 'runner-setup';
type PolicyOpts = CommonOpts & {
	permissions?: string;
	preset?: Preset;
	projects?: string;
	allProjects?: boolean;
	org?: string[];
	allOrgs?: boolean;
};

const PRESETS: Record<Preset, ApiKeyPermissions> = {
	full: FULL_API_KEY_PERMISSIONS,
	'read-only': READ_ONLY_API_KEY_PERMISSIONS,
	'project-automation': PROJECT_AUTOMATION_API_KEY_PERMISSIONS,
	'runner-setup': RUNNER_SETUP_API_KEY_PERMISSIONS
};

function clonePolicy(policy: ApiKeyPermissions): ApiKeyPermissions {
	return parseApiKeyPermissions(JSON.parse(JSON.stringify(policy)));
}

function policyFromOptions(opts: PolicyOpts): ApiKeyPermissions {
	if (Boolean(opts.permissions) === Boolean(opts.preset)) {
		die('pass exactly one of --permissions or --preset');
	}
	if (opts.permissions) {
		if (opts.projects || opts.allProjects) die('--projects/--all-projects require --preset');
		try {
			return parseApiKeyPermissions(JSON.parse(readBodyValue(opts.permissions)));
		} catch (error) {
			die(error instanceof Error ? error.message : 'invalid permission JSON');
		}
	}
	const preset = opts.preset!;
	const policy = clonePolicy(PRESETS[preset]);
	if (opts.projects && opts.allProjects) die('pass only one of --projects or --all-projects');
	if (opts.projects) {
		policy.projects.scope = opts.projects
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
		return parseApiKeyPermissions(policy);
	}
	if (opts.allProjects) policy.projects.scope = 'all';
	if (preset === 'project-automation' && policy.projects.scope.length === 0) {
		die('project-automation requires --projects <id,...> or --all-projects');
	}
	return policy;
}

/**
 * Applies `--org`/`--all-orgs` to a policy. With neither, a preset key gets
 * the caller's personal organization only — never `all`, which would include
 * organizations joined later — read off `GET /organizations` (the personal
 * one is `org_<user id>`, and there is no other way to learn the user id).
 * If this credential cannot see it, `organizations` is left out and the
 * server's version-1 default, the personal organization, applies. A
 * `--permissions` policy is used as written unless a flag is passed.
 */
async function withOrganizations(
	api: ApiClient,
	policy: ApiKeyPermissions,
	opts: PolicyOpts
): Promise<ApiKeyPermissions> {
	const orgRefs = opts.org ?? [];
	if (orgRefs.length && opts.allOrgs) die('pass only one of --org or --all-orgs');
	const flagged = orgRefs.length > 0 || Boolean(opts.allOrgs);
	if (flagged && opts.permissions && policy.organizations !== undefined)
		die('the --permissions policy already sets "organizations"; drop --org/--all-orgs');
	if (opts.allOrgs) return parseApiKeyPermissions({ ...policy, organizations: 'all' });
	if (orgRefs.length) {
		const ids: string[] = [];
		for (const ref of orgRefs) ids.push((await resolveOrganization(api, ref)).id);
		return parseApiKeyPermissions({ ...policy, organizations: ids });
	}
	if (opts.permissions) return policy;
	// A server from before organizations has no such list (404): its keys are
	// version 1, so the policy goes as it is.
	const listed = await api.listOrganizations().catch((error: unknown) => {
		if (error instanceof ApiError && error.status === 404) return { items: [] };
		throw error;
	});
	const personal = listed.items.find((o) => o.kind === 'personal');
	return personal ? parseApiKeyPermissions({ ...policy, organizations: [personal.id] }) : policy;
}

/** Organization ids to names, best effort: a key that cannot list them shows ids. */
async function organizationNames(api: ApiClient): Promise<Map<string, string>> {
	try {
		return new Map((await api.listOrganizations()).items.map((o) => [o.id, o.name]));
	} catch {
		return new Map();
	}
}

function orgScopeLabel(policy: ApiKeyPermissions, names: Map<string, string>): string {
	const orgs = policy.organizations;
	if (orgs === undefined) return 'personal only';
	if (orgs === 'all') return 'all (including ones joined later)';
	if (orgs.length === 0) return 'none';
	return orgs.map((id) => names.get(id) ?? id).join(',');
}

function scopeLabel(policy: ApiKeyPermissions): string {
	return policy.projects.scope === 'all'
		? 'all'
		: policy.projects.scope.length === 0
			? 'none'
			: policy.projects.scope.join(',');
}

function printKey(key: ApiKey, names: Map<string, string>): void {
	table([
		['ID', 'NAME', 'ORGANIZATIONS', 'PROJECTS', 'WORKSPACE', 'CONTROL', 'USABLE'],
		[
			key.id,
			key.name,
			orgScopeLabel(key.permissions, names),
			`${key.permissions.projects.access}:${scopeLabel(key.permissions)}`,
			key.permissions.workspace,
			key.permissions.control_plane,
			key.usable === false ? 'no' : 'yes'
		]
	]);
	if (key.run_restrictions) {
		console.log(
			`also restricted to run ${key.run_restrictions.run_id}, issue ${key.run_restrictions.issue_id}, project ${key.run_restrictions.project_id}`
		);
	}
}

function addPolicyOptions(command: Command, includePreset: boolean): Command {
	command.option(
		'--permissions <json|@file|->',
		'complete permission policy as JSON, @file, or stdin'
	);
	if (includePreset) {
		command.addOption(
			new Option('--preset <name>', 'permission preset').choices([
				'full',
				'read-only',
				'project-automation',
				'runner-setup'
			])
		);
		command.option('--projects <ids>', 'comma-separated explicit project IDs');
		command.option('--all-projects', 'explicitly use all projects');
		command.option(
			'--org <org>',
			'organization the key reaches, by id or name (repeatable; default: your personal one only)',
			// No `[]` default: commander would print it in the help text.
			(value: string, previous: string[] | undefined) => [...(previous ?? []), value]
		);
		command.option('--all-orgs', 'every organization you are in, including ones you join later');
	}
	return command;
}

export function register(program: Command): void {
	const keys = program.command('api-keys').description('Manage scoped API keys');

	withCommon(
		keys
			.command('list')
			.description('List your API keys')
			.addOption(
				new Option('--run-keys <mode>', 'run keys to include').choices(['none', 'active', 'all'])
			)
	).action(async (opts: CommonOpts & { runKeys?: RunKeyFilter }) => {
		const api = client(opts);
		const response = await api.listApiKeys({ run_keys: opts.runKeys });
		if (opts.json) return printJson(response);
		if (response.items.length === 0) return console.log('no API keys');
		const names = await organizationNames(api);
		for (const key of response.items) printKey(key, names);
	});

	withCommon(keys.command('show <id>').description('Show stored and effective authority')).action(
		async (id: string, opts: CommonOpts) => {
			const api = client(opts);
			const key = await api.getApiKey(id);
			if (opts.json) return printJson(key);
			printKey(key, await organizationNames(api));
		}
	);

	withCommon(keys.command('current').description('Inspect the acting credential authority')).action(
		async (opts: CommonOpts) => {
			const api = client(opts);
			const current = await api.getCurrentApiKeyAuthority();
			if (opts.json) return printJson(current);
			console.log(current.key ? `${current.key.name} (${current.key.id})` : 'browser session');
			const policy = current.authority.effective_permissions;
			console.log(
				`organizations ${orgScopeLabel(policy, await organizationNames(api))}; projects ${policy.projects.access}:${scopeLabel(policy)}; workspace ${policy.workspace}; control ${policy.control_plane}`
			);
			const run = current.authority.run_restrictions;
			if (run?.scope) console.log(`run ${run.run_id}: run scope ${runScopeLabel(run.scope)}`);
		}
	);

	withCommon(
		addPolicyOptions(keys.command('create <name>').description('Create a scoped key'), true)
	).action(async (name: string, opts: PolicyOpts) => {
		const api = client(opts);
		const permissions = await withOrganizations(api, policyFromOptions(opts), opts);
		const created = await api.createApiKey({ name, permissions });
		if (opts.json) return printJson(created);
		console.log(created.key);
		printKey(created, await organizationNames(api));
	});

	withCommon(
		addPolicyOptions(keys.command('update <id>').description('Replace key permissions'), false)
	).action(async (id: string, opts: PolicyOpts) => {
		if (!opts.permissions) die('--permissions is required');
		const api = client(opts);
		const current = await api.getApiKey(id);
		const permissions = policyFromOptions(opts);
		const updated = await api.updateApiKey(id, {
			permissions,
			expected_permissions: current.permissions
		});
		if (opts.json) return printJson(updated);
		printKey(updated, await organizationNames(api));
	});

	withCommon(keys.command('revoke <id>').description('Revoke a key')).action(
		async (id: string, opts: CommonOpts) => {
			await client(opts).revokeApiKey(id);
			if (opts.json) return printJson({ revoked: id });
			console.log(`revoked ${id}`);
		}
	);
}
