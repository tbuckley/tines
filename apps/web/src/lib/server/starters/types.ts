/**
 * The shape of a built-in starter (Tines/248).
 *
 * A starter is a library document with a first issue bolted on: its
 * `workflows` entries are literally `CreateWorkflowRequest`s (state `prompt`s
 * carry the stage instructions), its `context` entries are project-scoped
 * items, and `first_issue` seeds the one issue that gives the new project
 * something to run. Everything here is pure data — no DB, no `$lib/server`
 * imports — so the content files can be edited without touching the apply
 * path in `api/starters.ts`.
 */
import type {
	ContextKind,
	CreateWorkflowRequest,
	StarterId,
	StarterInputSpec
} from '@tines/shared';

/**
 * A context entry a starter creates on the new project. Always
 * project-scoped: state-scoped stage instructions travel as `states[].prompt`
 * on the workflow instead, because a reused workflow must not re-seed them.
 * `name`, `description`, `body`, `repo_url` and `repo_branch` are templates.
 */
export interface StarterContextEntry {
	kind: Exclude<ContextKind, 'artifact' | 'skill'>;
	name: string;
	description?: string;
	/** prompt */
	body?: string;
	/** repo */
	repo_url?: string;
	repo_branch?: string | null;
	repo_dir?: string | null;
}

/** The issue the starter files, so the project is not born empty. */
export interface StarterFirstIssue {
	/** Template. */
	title: string;
	/** Template. */
	description: string;
	/** The starter workflow's name. */
	workflow: string;
	/** A state name in that workflow — where the issue starts. */
	state: string;
}

export interface Starter {
	id: StarterId;
	/** Chooser card title. */
	name: string;
	/** One sentence for the chooser card. */
	description: string;
	inputs: StarterInputSpec[];
	workflows: CreateWorkflowRequest[];
	/** By name, like `LibraryProject.default_workflow`. */
	default_workflow: string | null;
	context: StarterContextEntry[];
	/** Prefills the project's "conventions" prompt; null for none. */
	conventions_template: string | null;
	first_issue: StarterFirstIssue | null;
}
