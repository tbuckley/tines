import { describe, expect, it } from 'vitest';
import type { Project } from '@tines/shared';
import { findProject, partitionProjects } from './archived';

function project(id: string, name: string, archivedAt: number | null): Project {
	return {
		id,
		name,
		description: '',
		default_workflow_id: null,
		issue_count: 0,
		archived_at: archivedAt,
		created_at: 1,
		updated_at: 1
	} as Project;
}

describe('partitionProjects', () => {
	it('splits archived from live, keeping server order within each half', () => {
		const a = project('p1', 'alpha', null);
		const b = project('p2', 'beta', 100);
		const c = project('p3', 'gamma', null);
		const d = project('p4', 'delta', 50);
		const { live, archived } = partitionProjects([a, b, c, d]);
		expect(live).toEqual([a, c]);
		expect(archived).toEqual([b, d]);
	});

	it('handles an empty list', () => {
		expect(partitionProjects([])).toEqual({ live: [], archived: [] });
	});
});

describe('findProject', () => {
	const projects = [project('p1', 'alpha', null), project('p2', 'beta', 100)];

	it('resolves by id and by name', () => {
		expect(findProject(projects, 'p2')?.name).toBe('beta');
		expect(findProject(projects, 'beta')?.id).toBe('p2');
	});

	it('returns null for an unknown, empty or missing ref', () => {
		expect(findProject(projects, 'nope')).toBeNull();
		expect(findProject(projects, '')).toBeNull();
		expect(findProject(projects, null)).toBeNull();
		expect(findProject(projects, undefined)).toBeNull();
	});
});
