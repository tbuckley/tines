import {
	FULL_API_KEY_PERMISSIONS,
	PROJECT_AUTOMATION_API_KEY_PERMISSIONS,
	READ_ONLY_API_KEY_PERMISSIONS,
	RUNNER_SETUP_API_KEY_PERMISSIONS,
	parseApiKeyPermissions,
	type ApiKey,
	type ApiKeyPermissions,
	type RunKeyFilter
} from '@tines/shared';
import { Option, type Command } from 'commander';
import { readBodyValue } from '../body-value.js';
import { client, die, printJson, table, withCommon, type CommonOpts } from '../common.js';

type Preset = 'full' | 'read-only' | 'project-automation' | 'runner-setup';
type PolicyOpts = CommonOpts & {
	permissions?: string;
	preset?: Preset;
	projects?: string;
	allProjects?: boolean;
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

function scopeLabel(policy: ApiKeyPermissions): string {
	return policy.projects.scope === 'all'
		? 'all'
		: policy.projects.scope.length === 0
			? 'none'
			: policy.projects.scope.join(',');
}

function printKey(key: ApiKey): void {
	table([
		['ID', 'NAME', 'PROJECTS', 'WORKSPACE', 'CONTROL', 'USABLE'],
		[
			key.id,
			key.name,
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
	}
	return command;
}

export function register(program: Command): void {
	const keys = program.command('api-keys').description('Manage scoped API keys');

	withCommon(
		keys
			.command('list')
			.addOption(
				new Option('--run-keys <mode>', 'run keys to include').choices(['none', 'active', 'all'])
			)
	).action(async (opts: CommonOpts & { runKeys?: RunKeyFilter }) => {
		const response = await client(opts).listApiKeys({ run_keys: opts.runKeys });
		if (opts.json) return printJson(response);
		if (response.items.length === 0) return console.log('no API keys');
		for (const key of response.items) printKey(key);
	});

	withCommon(keys.command('show <id>').description('Show stored and effective authority')).action(
		async (id: string, opts: CommonOpts) => {
			const key = await client(opts).getApiKey(id);
			if (opts.json) return printJson(key);
			printKey(key);
		}
	);

	withCommon(keys.command('current').description('Inspect the acting credential authority')).action(
		async (opts: CommonOpts) => {
			const current = await client(opts).getCurrentApiKeyAuthority();
			if (opts.json) return printJson(current);
			console.log(current.key ? `${current.key.name} (${current.key.id})` : 'browser session');
			const policy = current.authority.effective_permissions;
			console.log(
				`projects ${policy.projects.access}:${scopeLabel(policy)}; workspace ${policy.workspace}; control ${policy.control_plane}`
			);
		}
	);

	withCommon(
		addPolicyOptions(keys.command('create <name>').description('Create a scoped key'), true)
	).action(async (name: string, opts: PolicyOpts) => {
		const created = await client(opts).createApiKey({ name, permissions: policyFromOptions(opts) });
		if (opts.json) return printJson(created);
		console.log(created.key);
		printKey(created);
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
		printKey(updated);
	});

	withCommon(keys.command('revoke <id>').description('Revoke a key')).action(
		async (id: string, opts: CommonOpts) => {
			await client(opts).revokeApiKey(id);
			if (opts.json) return printJson({ revoked: id });
			console.log(`revoked ${id}`);
		}
	);
}
