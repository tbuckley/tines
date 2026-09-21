import { describe, expect, it } from 'vitest';
import {
	accessIncludes,
	apiKeyPermissionsSubset,
	FULL_API_KEY_PERMISSIONS,
	intersectApiKeyPermissions,
	parseApiKeyPermissions,
	permissionsIncludeProject
} from './permissions.js';

describe('API key permissions', () => {
	it('normalizes the unversioned example and sorts project IDs', () => {
		expect(
			parseApiKeyPermissions({
				projects: { access: 'write', scope: ['prj_b', 'prj_a'] },
				workspace: 'read',
				control_plane: 'none'
			})
		).toEqual({
			version: 1,
			projects: { access: 'write', scope: ['prj_a', 'prj_b'] },
			workspace: 'read',
			control_plane: 'none'
		});
	});

	it.each([
		[undefined, 'permissions'],
		[
			{ projects: { access: 'none', scope: 'all' }, workspace: 'read', control_plane: 'none' },
			'permissions.projects.access'
		],
		[
			{ projects: { access: 'read', scope: ['nope'] }, workspace: 'read', control_plane: 'none' },
			'permissions.projects.scope'
		],
		[
			{
				projects: { access: 'read', scope: ['prj_a', 'prj_a'] },
				workspace: 'read',
				control_plane: 'none'
			},
			'permissions.projects.scope'
		],
		[
			{
				version: 2,
				projects: { access: 'read', scope: 'all' },
				workspace: 'read',
				control_plane: 'none'
			},
			'permissions.version'
		],
		[
			{
				projects: { access: 'read', scope: 'all' },
				workspace: 'read',
				control_plane: 'none',
				surprise: true
			},
			'permissions.surprise'
		]
	])('rejects malformed policy %#', (value, field) => {
		expect(() => parseApiKeyPermissions(value)).toThrow(expect.objectContaining({ field }));
	});

	it('orders cumulative access levels', () => {
		expect(accessIncludes('delete', 'write')).toBe(true);
		expect(accessIncludes('write', 'read')).toBe(true);
		expect(accessIncludes('read', 'write')).toBe(false);
		expect(accessIncludes('none', 'read')).toBe(false);
	});

	it('requires both project level and scope', () => {
		const policy = parseApiKeyPermissions({
			projects: { access: 'write', scope: ['prj_a'] },
			workspace: 'none',
			control_plane: 'none'
		});
		expect(permissionsIncludeProject(policy, 'prj_a', 'read')).toBe(true);
		expect(permissionsIncludeProject(policy, 'prj_a', 'delete')).toBe(false);
		expect(permissionsIncludeProject(policy, 'prj_b', 'read')).toBe(false);
	});

	it('checks delegation without treating an empty project scope as authority', () => {
		const empty = parseApiKeyPermissions({
			projects: { access: 'delete', scope: [] },
			workspace: 'read',
			control_plane: 'none'
		});
		expect(apiKeyPermissionsSubset(empty, FULL_API_KEY_PERMISSIONS)).toBe(true);
		expect(apiKeyPermissionsSubset(FULL_API_KEY_PERMISSIONS, empty)).toBe(false);
	});

	it('intersects levels and project sets independently', () => {
		const scoped = parseApiKeyPermissions({
			projects: { access: 'write', scope: ['prj_a', 'prj_b'] },
			workspace: 'read',
			control_plane: 'none'
		});
		expect(intersectApiKeyPermissions(FULL_API_KEY_PERMISSIONS, scoped)).toEqual(scoped);
	});
});
