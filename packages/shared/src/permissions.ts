export const ACCESS_LEVELS = ['none', 'read', 'write', 'delete'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export type ProjectAccessLevel = Exclude<AccessLevel, 'none'>;

export interface ApiKeyPermissions {
	version: 1;
	projects: {
		access: ProjectAccessLevel;
		scope: 'all' | string[];
	};
	workspace: AccessLevel;
	control_plane: AccessLevel;
}

export const MAX_PERMISSION_PROJECTS = 10_000;
export const MAX_PERMISSION_PROJECT_ID_LENGTH = 100;

export const FULL_API_KEY_PERMISSIONS: ApiKeyPermissions = Object.freeze({
	version: 1,
	projects: Object.freeze({ access: 'delete', scope: 'all' }),
	workspace: 'delete',
	control_plane: 'delete'
});

export const READ_ONLY_API_KEY_PERMISSIONS: ApiKeyPermissions = Object.freeze({
	version: 1,
	projects: Object.freeze({ access: 'read', scope: 'all' }),
	workspace: 'read',
	control_plane: 'read'
});

export const PROJECT_AUTOMATION_API_KEY_PERMISSIONS: ApiKeyPermissions = Object.freeze({
	version: 1,
	projects: Object.freeze({ access: 'write', scope: Object.freeze([]) as unknown as string[] }),
	workspace: 'read',
	control_plane: 'none'
});

export const RUNNER_SETUP_API_KEY_PERMISSIONS: ApiKeyPermissions = Object.freeze({
	version: 1,
	projects: Object.freeze({ access: 'write', scope: 'all' }),
	workspace: 'write',
	control_plane: 'write'
});

const ACCESS_RANK: Record<AccessLevel, number> = {
	none: 0,
	read: 1,
	write: 2,
	delete: 3
};

export class ApiKeyPermissionsValidationError extends Error {
	constructor(
		message: string,
		public readonly field = 'permissions'
	) {
		super(message);
		this.name = 'ApiKeyPermissionsValidationError';
	}
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ApiKeyPermissionsValidationError(`"${field}" must be an object`, field);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	field: string
): void {
	const unknown = Object.keys(value).find((key) => !allowed.includes(key));
	if (unknown !== undefined) {
		throw new ApiKeyPermissionsValidationError(
			`"${field}.${unknown}" is not a supported permission field`,
			`${field}.${unknown}`
		);
	}
}

function accessAt(value: unknown, field: string, allowNone: boolean): AccessLevel {
	if (
		typeof value !== 'string' ||
		!(ACCESS_LEVELS as readonly string[]).includes(value) ||
		(!allowNone && value === 'none')
	) {
		const levels = allowNone ? ACCESS_LEVELS : ACCESS_LEVELS.slice(1);
		throw new ApiKeyPermissionsValidationError(
			`"${field}" must be one of ${levels.join(', ')}`,
			field
		);
	}
	return value as AccessLevel;
}

function projectScopeAt(value: unknown): 'all' | string[] {
	if (value === 'all') return 'all';
	if (!Array.isArray(value)) {
		throw new ApiKeyPermissionsValidationError(
			'"permissions.projects.scope" must be "all" or an array of project IDs',
			'permissions.projects.scope'
		);
	}
	if (value.length > MAX_PERMISSION_PROJECTS) {
		throw new ApiKeyPermissionsValidationError(
			`"permissions.projects.scope" must contain at most ${MAX_PERMISSION_PROJECTS} project IDs`,
			'permissions.projects.scope'
		);
	}
	const seen = new Set<string>();
	for (const id of value) {
		if (
			typeof id !== 'string' ||
			id.length > MAX_PERMISSION_PROJECT_ID_LENGTH ||
			!/^prj_[A-Za-z0-9_-]+$/.test(id)
		) {
			throw new ApiKeyPermissionsValidationError(
				'"permissions.projects.scope" entries must be valid project IDs',
				'permissions.projects.scope'
			);
		}
		if (seen.has(id)) {
			throw new ApiKeyPermissionsValidationError(
				`"permissions.projects.scope" contains duplicate project ID "${id}"`,
				'permissions.projects.scope'
			);
		}
		seen.add(id);
	}
	return [...seen].sort();
}

/** Parse the public policy shape and return its canonical versioned form. */
export function parseApiKeyPermissions(value: unknown): ApiKeyPermissions {
	const policy = objectAt(value, 'permissions');
	rejectUnknownKeys(policy, ['version', 'projects', 'workspace', 'control_plane'], 'permissions');
	if (policy.version !== undefined && policy.version !== 1) {
		throw new ApiKeyPermissionsValidationError(
			'"permissions.version" must be 1',
			'permissions.version'
		);
	}
	for (const field of ['projects', 'workspace', 'control_plane'] as const) {
		if (!(field in policy)) {
			throw new ApiKeyPermissionsValidationError(
				`"permissions.${field}" is required`,
				`permissions.${field}`
			);
		}
	}
	const projects = objectAt(policy.projects, 'permissions.projects');
	rejectUnknownKeys(projects, ['access', 'scope'], 'permissions.projects');
	if (!('access' in projects) || !('scope' in projects)) {
		const missing = !('access' in projects) ? 'access' : 'scope';
		throw new ApiKeyPermissionsValidationError(
			`"permissions.projects.${missing}" is required`,
			`permissions.projects.${missing}`
		);
	}
	return {
		version: 1,
		projects: {
			access: accessAt(projects.access, 'permissions.projects.access', false) as ProjectAccessLevel,
			scope: projectScopeAt(projects.scope)
		},
		workspace: accessAt(policy.workspace, 'permissions.workspace', true),
		control_plane: accessAt(policy.control_plane, 'permissions.control_plane', true)
	};
}

export function accessIncludes(actual: AccessLevel, required: AccessLevel): boolean {
	return ACCESS_RANK[actual] >= ACCESS_RANK[required];
}

export function permissionsIncludeProject(
	permissions: ApiKeyPermissions,
	projectId: string,
	required: ProjectAccessLevel
): boolean {
	return (
		accessIncludes(permissions.projects.access, required) &&
		(permissions.projects.scope === 'all' || permissions.projects.scope.includes(projectId))
	);
}

/** Whether every authority in `proposed` is contained by `granter`. */
export function apiKeyPermissionsSubset(
	proposed: ApiKeyPermissions,
	granter: ApiKeyPermissions
): boolean {
	if (!accessIncludes(granter.workspace, proposed.workspace)) return false;
	if (!accessIncludes(granter.control_plane, proposed.control_plane)) return false;
	if (proposed.projects.scope.length === 0) return true;
	if (!accessIncludes(granter.projects.access, proposed.projects.access)) return false;
	if (granter.projects.scope === 'all') return true;
	if (proposed.projects.scope === 'all') return false;
	return proposed.projects.scope.every((id) => granter.projects.scope.includes(id));
}

export function intersectApiKeyPermissions(
	left: ApiKeyPermissions,
	right: ApiKeyPermissions
): ApiKeyPermissions {
	let scope: 'all' | string[];
	if (left.projects.scope === 'all') scope = right.projects.scope;
	else if (right.projects.scope === 'all') scope = left.projects.scope;
	else scope = left.projects.scope.filter((id) => right.projects.scope.includes(id));
	const lower = <T extends AccessLevel>(a: T, b: T): T =>
		ACCESS_RANK[a] <= ACCESS_RANK[b] ? a : b;
	return {
		version: 1,
		projects: {
			access: lower(left.projects.access, right.projects.access),
			scope: scope === 'all' ? 'all' : [...scope].sort()
		},
		workspace: lower(left.workspace, right.workspace),
		control_plane: lower(left.control_plane, right.control_plane)
	};
}

export function serializeApiKeyPermissions(permissions: ApiKeyPermissions): string {
	return JSON.stringify(parseApiKeyPermissions(permissions));
}
