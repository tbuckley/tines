import { describe, expect, it } from 'vitest';
import type { Project } from '@tines/shared';
import { defaultProjectId } from './focus';

const project = (id: string): Project => ({ id }) as Project;
const two = [project('prj_a'), project('prj_b')];

describe('defaultProjectId', () => {
	it('is the focus when it is one of the projects', () => {
		expect(defaultProjectId(two, 'prj_b', 'prj_a')).toBe('prj_b');
	});

	it('falls back to the last project under All projects', () => {
		expect(defaultProjectId(two, null, 'prj_b')).toBe('prj_b');
	});

	it('ignores a focus or a last project that is no longer listed', () => {
		expect(defaultProjectId(two, 'prj_gone', 'prj_a')).toBe('prj_a');
		expect(defaultProjectId(two, null, 'prj_gone')).toBe('');
	});

	it('is empty at two or more projects with nothing to fall back to — never projects[0]', () => {
		expect(defaultProjectId(two, null, null)).toBe('');
	});

	it('is the single project when there is only one, which behaves as the focus', () => {
		expect(defaultProjectId([project('prj_a')], null, null)).toBe('prj_a');
	});

	it('is empty with no projects at all', () => {
		expect(defaultProjectId([], null, null)).toBe('');
	});
});
