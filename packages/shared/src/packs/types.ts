/**
 * Packs (specs/packs/MVP_SPEC.md): the parsed, validated form of a pack
 * folder, shared by the server (install, replace, export), the CLI
 * (`tines packs validate`) and the web UI (review screens).
 *
 * The folder is the source of truth; `PackModel` is what `parsePack` makes of
 * it, and `writePackFiles` turns a model back into the same files.
 */
import type { ArtifactRequirement, SchedulePreset, StateCategory } from '../index.js';

/** The pack format version this code reads and writes. A newer one is refused. */
export const PACK_FORMAT = 1;

/** `pack.yaml` `id`. */
export const PACK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/;
/** Workflow and state keys: their folder names. */
export const PACK_KEY_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
/** Input names. */
export const PACK_INPUT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
/** The whole archive, compressed or not. */
export const PACK_ARCHIVE_MAX_BYTES = 5 * 1024 * 1024;
/** Each Markdown/YAML file outside skills (prompts have their own cap). */
export const PACK_TEXT_FILE_MAX_BYTES = 256 * 1024;
/** File extension of a zipped pack. */
export const PACK_ARCHIVE_EXTENSION = '.tinespack';

/** Where a context item applies, set by the folder it is in. */
export type PackReach = 'project' | 'pack' | 'workflow' | 'state';
export const PACK_REACHES: readonly PackReach[] = ['project', 'pack', 'workflow', 'state'];

/** The run scopes the pack format uses. `organization` is stored as `workspace` until organizations ship. */
export type PackRunScope = 'issue' | 'project' | 'organization';
export const PACK_RUN_SCOPES: readonly PackRunScope[] = ['issue', 'project', 'organization'];

export type PackInputType = 'text' | 'secret' | 'repo' | 'workflow';
export const PACK_INPUT_TYPES: readonly PackInputType[] = ['text', 'secret', 'repo', 'workflow'];

export type PackInputDecl =
	| {
			type: 'text';
			description: string;
			default?: string;
			/** Default true; `false` renders a missing value as empty text. */
			required?: boolean;
	  }
	| { type: 'secret'; description: string }
	| { type: 'repo'; description: string; default_branch?: string }
	| {
			type: 'workflow';
			description: string;
			/** `<workflow>` or `<workflow>/<state>`, naming a workflow in this pack by key. */
			default?: string;
	  };

/** `pack.yaml`. `version` is null only for an authored pack that was never exported. */
export interface PackManifest {
	format: number;
	id: string;
	name: string;
	version: number | null;
	description: string;
	derived_from: { id: string; version: number | null } | null;
	/** In declaration order. */
	inputs: Record<string, PackInputDecl>;
}

/** Which folder an item came from. `workflow` is set for workflow and state reach, `state` for state reach. */
export interface PackLocation {
	reach: PackReach;
	workflow: string | null;
	state: string | null;
}

export interface PackPrompt extends PackLocation {
	/** The file stem. */
	name: string;
	description: string;
	/** Default 100; ascending, then by name. */
	order: number;
	/** The template, placeholders and all, without frontmatter. */
	body: string;
}

export interface PackSkillFile {
	/** Relative to the skill folder, e.g. `SKILL.md` or `scripts/check.sh`. */
	path: string;
	content: string;
}

export interface PackSkill extends PackLocation {
	/** The folder name; equals `SKILL.md`'s frontmatter `name`. */
	name: string;
	/** `SKILL.md`'s frontmatter `description`. */
	description: string;
	files: PackSkillFile[];
}

export interface PackEnv extends PackLocation {
	name: string;
	/** A template string, or a reference to a `text`/`secret` input. */
	value: { template: string } | { input: string };
}

export interface PackRepo extends PackLocation {
	name: string;
	/** Bound to a `repo` input, or fixed. Exactly one of `input` and `url` is set. */
	input: string | null;
	url: string | null;
	branch: string | null;
	dir: string | null;
}

export interface PackTransition {
	name: string;
	/** A state key in the same workflow. */
	to: string;
	requires?: ArtifactRequirement[];
}

export interface PackState {
	key: string;
	name: string;
	category: StateCategory;
	run_scope: PackRunScope;
	transitions: PackTransition[];
}

export interface PackWorkflow {
	key: string;
	name: string;
	description: string;
	/** A state key. */
	initial: string;
	/** In display order. */
	states: PackState[];
}

export type PackRecurrence =
	| {
			every: 'hourly' | 'daily' | 'weekly' | 'monthly' | `${number}h`;
			/** Weekday name or 0-6 (weekly); day of month (monthly). */
			on?: string | number;
			/** `HH:MM`, or the minute past the hour for hourly. */
			at?: string;
	  }
	| { cron: string };

export interface PackSchedule {
	/** The file stem: identifies the suggestion across versions. */
	key: string;
	name: string;
	/** A workflow key in this pack. */
	workflow: string;
	/** A state key; null = the workflow's initial state. */
	start: string | null;
	recurrence: PackRecurrence;
	only_when_previous_closed: boolean;
	title: string;
	description: string;
}

export interface PackMigrationEntry {
	/** Old key → new key, as `<workflow>` or `<workflow>/<state>`. */
	renamed: Record<string, string>;
	/** Removed key → suggested destination, as `<workflow>/<state>` (or `<workflow>`). */
	removed: Record<string, string>;
}

/** One file of a pack, normalized: forward-slash relative path, raw bytes. */
export interface PackFile {
	path: string;
	bytes: Uint8Array;
}

export interface PackModel {
	manifest: PackManifest;
	readme: string | null;
	changelog: string | null;
	/** Keyed by version, as written. */
	migrations: Record<string, PackMigrationEntry>;
	workflows: PackWorkflow[];
	prompts: PackPrompt[];
	skills: PackSkill[];
	env: PackEnv[];
	repos: PackRepo[];
	schedules: PackSchedule[];
}

export type PackIssueLevel = 'error' | 'warning';

export interface PackIssue {
	level: PackIssueLevel;
	/** Stable machine code, e.g. `unknown_input`. */
	code: string;
	/** The file the issue is about, when there is one. */
	path: string | null;
	message: string;
}

export interface PackParseResult {
	/** Null when there are errors. */
	model: PackModel | null;
	errors: PackIssue[];
	warnings: PackIssue[];
	/** The normalized files (clutter dropped, single top folder stripped). */
	files: PackFile[];
	/** `packDigest(files)`; empty string when the archive itself could not be read. */
	digest: string;
}

/** A schedule recurrence compiled for the schedules API. */
export type CompiledRecurrence = { preset: SchedulePreset } | { cron: string };
