/**
 * Applying a built-in starter atomically with the project it creates
 * (Tines/248).
 *
 * The hard constraint is atomicity: the workflows, the conventions prompt,
 * the repo item and the first issue all land in `createProject`'s single
 * `runAtomic` batch, or none of them do. That rules out calling
 * `createWorkflow` / `createContextItem` / `createIssue`, each of which runs
 * its own batch and reads rows this batch has not written yet. So every read
 * happens up front here, and what comes back is two lists of statements that
 * bracket the project insert in foreign-key order:
 *
 *     before:  workflow → states → transitions → stage prompts → pointers
 *     (project row + project.created)
 *     after:   conventions → context items → first issue
 */
import {
	PROJECT_PROMPT_NAME,
	STARTER_IDS,
	renderTemplate,
	repoDirFromUrl,
	type ContextKind,
	type CreateProjectRequest,
	type StarterApplied,
	type StarterId,
	type StarterSummary
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { STARTERS, type Starter } from '$lib/server/starters';
import { seedPromptQueries, seedRepoQueries } from './context';
import { ApiFail, type ActorContext } from './core';
import { issueInsertQueries } from './issues';
import {
	loadWorkflows,
	resolveDef,
	resolveInheritance,
	workflowAsRequest,
	workflowFingerprint,
	workflowInsertQueries,
	type ResolvedDef
} from './workflows';

export type StarterRegistry = Readonly<Record<string, Starter>>;

/** The chooser's menu: what each starter asks for and what it will create. */
export function listStarters(registry: StarterRegistry = STARTERS): StarterSummary[] {
	return Object.values(registry).map((s) => ({
		id: s.id,
		name: s.name,
		description: s.description,
		inputs: s.inputs,
		conventions_template: s.conventions_template,
		creates: {
			workflows: s.workflows.map((w) => ({
				name: w.name,
				default: w.name === s.default_workflow,
				states: w.states.map((st) => st.name)
			})),
			context: s.context.map((c) => ({ kind: c.kind as ContextKind, name: c.name })),
			first_issue: s.first_issue
				? {
						title: s.first_issue.title,
						workflow: s.first_issue.workflow,
						state: s.first_issue.state
					}
				: null
		}
	}));
}

export interface ResolvedStarter {
	starter: Starter;
	/** Every declared input, trimmed; absent optional inputs are `''`. */
	inputs: Record<string, string>;
}

/**
 * Validates `body.starter` against the registry. Pure and total: it runs
 * before any read, so a typo'd id or a missing input 422s without touching
 * the database. Returns null for "no starter" — an absent field, or `blank`,
 * which creates nothing.
 */
export function resolveStarter(
	input: CreateProjectRequest['starter'],
	registry: StarterRegistry = STARTERS
): ResolvedStarter | null {
	if (input === undefined || input === null) return null;
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new ApiFail(422, 'invalid_field', '"starter" must be an object with an "id"', {
			field: 'starter'
		});
	}
	const id = input.id;
	if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(registry, id)) {
		throw new ApiFail(
			422,
			'unknown_starter',
			`Unknown starter ${JSON.stringify(id ?? null)}; GET /api/v1/projects/starters lists them`,
			{ field: 'starter.id', known: Object.keys(registry) }
		);
	}
	const starter = registry[id];

	const raw = input.inputs ?? {};
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ApiFail(422, 'invalid_field', '"starter.inputs" must be an object of strings', {
			field: 'starter.inputs'
		});
	}
	const allowed = starter.inputs.map((i) => i.key);
	// A typo'd key must not be silently dropped: the whole point of the input
	// is that it ends up in the repo item or the first issue's title.
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key as (typeof allowed)[number])) {
			throw new ApiFail(
				422,
				'unknown_starter_input',
				`Starter "${starter.id}" has no input "${key}"`,
				{ field: `starter.inputs.${key}`, allowed }
			);
		}
	}

	const inputs: Record<string, string> = {};
	for (const spec of starter.inputs) {
		const value = raw[spec.key];
		if (value !== undefined && typeof value !== 'string') {
			throw new ApiFail(422, 'invalid_field', `"starter.inputs.${spec.key}" must be a string`, {
				field: `starter.inputs.${spec.key}`
			});
		}
		const trimmed = (value ?? '').trim();
		if (spec.required && trimmed === '') {
			throw new ApiFail(
				422,
				'missing_starter_input',
				`Starter "${starter.id}" needs "${spec.key}" (${spec.label})`,
				{ field: `starter.inputs.${spec.key}` }
			);
		}
		const max = spec.max ?? 10_000;
		if (trimmed.length > max) {
			throw new ApiFail(
				422,
				'invalid_field',
				`"starter.inputs.${spec.key}" is longer than ${max} characters`,
				{ field: `starter.inputs.${spec.key}`, max }
			);
		}
		inputs[spec.key] = trimmed;
	}

	// `blank` declares nothing, so it is exactly the absent case.
	if (starter.workflows.length === 0 && starter.context.length === 0 && !starter.first_issue) {
		return null;
	}
	return { starter, inputs };
}

export interface StarterPlan {
	/** Statements that must precede the project row (workflows). */
	before: CompiledQuery[];
	/** Statements that must follow it (context, first issue). */
	after: CompiledQuery[];
	/** The starter's default workflow, created or reused. */
	defaultWorkflowId: string | null;
	/** The rendered conventions template, or null. */
	conventions: string | null;
	applied: StarterApplied;
}

/** How each starter workflow resolves against what already exists. */
interface WorkflowPlacement {
	starterName: string;
	id: string;
	name: string;
	reused: boolean;
	/** Reuse: the existing states, so the first issue can name one. */
	existingStates?: { id: string; name: string }[];
	/** Create: the resolved definition plus everything the insert needs. */
	created?: { def: ResolvedDef; description: string; queries: CompiledQuery[] };
}

const MAX_WORKFLOW_NAME = 200;
const MAX_CONTEXT_NAME = 100;

/**
 * A rename must never fail the creation it decorates, so the project suffix
 * is what gets truncated, not the workflow's own name.
 */
function collisionName(base: string, projectName: string): string {
	const room = MAX_WORKFLOW_NAME - base.length - ' ()'.length;
	if (room <= 0) return base.slice(0, MAX_WORKFLOW_NAME);
	return `${base} (${projectName.slice(0, room)})`;
}

export async function starterQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	opts: {
		starter: Starter;
		inputs: Record<string, string>;
		projectId: string;
		projectName: string;
		now: number;
	}
): Promise<StarterPlan> {
	const { starter, inputs, projectId, projectName, now } = opts;
	const vars: Record<string, string> = {
		...inputs,
		project: projectName,
		repo_name: inputs.repo_url ? repoDirFromUrl(inputs.repo_url) : ''
	};
	const render = (t: string) => renderTemplate(t, vars);

	// ---- reads -------------------------------------------------------------
	const existing = await loadWorkflows(db, actor.userId);
	const placements: WorkflowPlacement[] = [];
	for (const wf of starter.workflows) {
		const sameName = existing.filter((e) => e.name === wf.name);
		const fingerprint = workflowFingerprint(wf);
		// `loadWorkflows` orders system-first then oldest-first, so the first
		// structural match is the most canonical one.
		const identical = sameName.find(
			(e) => workflowFingerprint(workflowAsRequest(e)) === fingerprint
		);
		if (identical) {
			placements.push({
				starterName: wf.name,
				id: identical.id,
				name: identical.name,
				reused: true,
				existingStates: identical.states.map((s) => ({ id: s.id, name: s.name }))
			});
			continue;
		}
		const name = sameName.length ? collisionName(wf.name, projectName) : wf.name;
		const id = newId('wf');
		const def = resolveDef(wf.states, wf.transitions ?? [], wf.initial_state, []);
		const inh = await resolveInheritance(db, actor.userId, { id, name }, def.states, []);
		const description = wf.description ?? '';
		placements.push({
			starterName: wf.name,
			id,
			name,
			reused: false,
			created: {
				def,
				description,
				queries: workflowInsertQueries(db, actor, {
					id,
					name,
					description,
					def,
					inh,
					now,
					eventPayload: { starter: starter.id }
				})
			}
		});
	}

	// ---- assembly ----------------------------------------------------------
	const before = placements.flatMap((p) => p.created?.queries ?? []);
	const after: CompiledQuery[] = [];
	const appliedContext: StarterApplied['context'] = [];

	// Position 0 belongs to the conventions prompt, which `createProject`
	// seeds itself (an explicit `initial_prompt` overrides the template).
	let position = 1;
	for (const entry of starter.context) {
		const name = render(entry.name).slice(0, MAX_CONTEXT_NAME);
		const label = `project ${projectName}`;
		if (entry.kind === 'repo') {
			const repoUrl = render(entry.repo_url ?? '').trim();
			if (!repoUrl) {
				throw new ApiFail(
					422,
					'missing_starter_input',
					`Starter "${starter.id}" needs a repository URL for "${name}"`,
					{ field: 'starter.inputs.repo_url' }
				);
			}
			const seeded = seedRepoQueries(db, actor, {
				name,
				description: entry.description ? render(entry.description) : '',
				repoUrl,
				repoBranch: entry.repo_branch ? render(entry.repo_branch).trim() || null : null,
				repoDir: entry.repo_dir ?? null,
				projectId,
				position: position++,
				label,
				now
			});
			after.push(...seeded.queries);
			appliedContext.push({ id: seeded.id, kind: 'repo', name });
		} else {
			const seeded = seedPromptQueries(db, actor, {
				name,
				body: render(entry.body ?? ''),
				projectId,
				label,
				now
			});
			after.push(...seeded.queries);
			appliedContext.push({ id: seeded.id, kind: 'prompt', name });
			position++;
		}
	}

	let firstIssue: StarterApplied['first_issue'] = null;
	if (starter.first_issue) {
		const spec = starter.first_issue;
		const placement = placements.find((p) => p.starterName === spec.workflow);
		if (!placement) {
			throw new ApiFail(
				422,
				'invalid_starter',
				`Starter "${starter.id}" files its first issue in unknown workflow "${spec.workflow}"`
			);
		}
		// Both branches name the state the same way — by name — because on the
		// reuse path the starter's own state ids were never inserted.
		const states = placement.reused
			? (placement.existingStates ?? [])
			: (placement.created?.def.states ?? []).map((st) => ({ id: st.id, name: st.name }));
		const state = states.find((st) => st.name === spec.state);
		if (!state) {
			throw new ApiFail(
				422,
				'invalid_starter',
				`Starter "${starter.id}" files its first issue in state "${spec.state}", which workflow "${placement.name}" does not have`,
				{ known_states: states.map((st) => st.name) }
			);
		}
		const id = newId('iss');
		after.push(
			...issueInsertQueries(db, actor, {
				id,
				projectId,
				title: render(spec.title).slice(0, 500),
				description: render(spec.description),
				workflowId: placement.id,
				stateId: state.id,
				stateName: state.name,
				now
			})
		);
		// The project is brand new, so this is issue #1 by construction.
		firstIssue = { id, number: 1, ref: `${projectName}/1`, state_name: state.name };
	}

	const defaultPlacement = starter.default_workflow
		? placements.find((p) => p.starterName === starter.default_workflow)
		: undefined;

	return {
		before,
		after,
		defaultWorkflowId: defaultPlacement?.id ?? null,
		conventions: starter.conventions_template ? render(starter.conventions_template) : null,
		applied: {
			id: starter.id as StarterId,
			workflows: placements.map((p) => ({ id: p.id, name: p.name, reused: p.reused })),
			context: appliedContext,
			first_issue: firstIssue
		}
	};
}

export { STARTER_IDS };
