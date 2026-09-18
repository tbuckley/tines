import type { Starter } from './types';

/**
 * The absence of a starter, named. Applying it is byte-for-byte today's
 * `createProject`: no workflows, no context, no first issue.
 */
export const blank: Starter = {
	id: 'blank',
	name: 'Blank project',
	description: 'An empty project. Add workflows, context and issues yourself.',
	inputs: [],
	workflows: [],
	default_workflow: null,
	context: [],
	conventions_template: null,
	first_issue: null
};
