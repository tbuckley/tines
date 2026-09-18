import type { Project } from '@tines/shared';
import { ALICE } from './constants.mjs';
import { expect, test } from './fixtures';
import { body } from './helpers';

test('the same stem is safe in another spec', async ({ apiFor, uniqueName }) => {
	const project = await body<Project>(
		await apiFor(ALICE).post('/api/v1/projects', { name: uniqueName('fixture-cross-file') })
	);
	expect(project.name).toContain('fixture-cross-file'.slice(0, 10));
});
