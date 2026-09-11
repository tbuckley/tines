/** Strict runtime shapes. Never traverse references or hash a draft before this boundary. */
import {
	ARTIFACT_TYPES,
	LABEL_COLORS,
	LABEL_NAME_MAX,
	MODEL_TIERS,
	STATE_CATEGORIES,
	PROMPT_MAX_BYTES,
	SKILL_MAX_FILES,
	SKILL_MAX_TOTAL_BYTES,
	canonicalGitHubRepoUrl
} from '../types.js';
import {
	compilePreset,
	validateScheduleCron,
	validateTimezone,
	type SchedulePreset
} from '../schedule.js';
import { LibraryValidationError, type PortableLibraryV3Document } from './types.js';

type Check = (value: unknown, path: string) => void;
export const pointer = (path: string, key: string | number) =>
	`${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
export function invalid(path: string, code: string, message: string): never {
	throw new LibraryValidationError([{ path, code, message }]);
}
export function validateUnicode(value: string, path: string): void {
	for (let i = 0; i < value.length; i++) {
		const unit = value.charCodeAt(i);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(++i);
			if (!(next >= 0xdc00 && next <= 0xdfff))
				invalid(path, 'invalid_unicode', 'Lone UTF-16 surrogate is not allowed');
		} else if (unit >= 0xdc00 && unit <= 0xdfff)
			invalid(path, 'invalid_unicode', 'Lone UTF-16 surrogate is not allowed');
	}
}
const text =
	(max: number, nonempty = false): Check =>
	(v, p) => {
		if (typeof v !== 'string') invalid(p, 'invalid_type', 'Expected a string');
		validateUnicode(v, p);
		if (v.length > max || (nonempty && !v.trim()))
			invalid(
				p,
				'invalid_field',
				`Expected ${nonempty ? 'non-empty ' : ''}text of at most ${max} characters`
			);
	};
const bool: Check = (v, p) => {
	if (typeof v !== 'boolean') invalid(p, 'invalid_type', 'Expected a boolean');
};
const integer: Check = (v, p) => {
	if (!Number.isSafeInteger(v) || (v as number) < 0)
		invalid(p, 'invalid_integer', 'Expected a non-negative safe integer');
};
const oneOf =
	(values: readonly unknown[]): Check =>
	(v, p) => {
		if (!values.includes(v)) invalid(p, 'invalid_value', `Expected one of ${values.join(', ')}`);
	};
const nullable =
	(check: Check): Check =>
	(v, p) => {
		if (v !== null) check(v, p);
	};
const array =
	(check: Check, max = 1000): Check =>
	(v, p) => {
		if (!Array.isArray(v)) invalid(p, 'invalid_type', 'Expected an array');
		if (v.length > max) invalid(p, 'package_too_large', `Array exceeds ${max} entries`);
		for (let i = 0; i < v.length; i++) check(v[i], pointer(p, i));
	};
function object(v: unknown, p: string): Record<string, unknown> {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(v))
	)
		invalid(p, 'invalid_type', 'Expected a plain object');
	return v as Record<string, unknown>;
}
const shape =
	(required: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
	(v, p) => {
		const o = object(v, p);
		for (const key of Object.keys(o)) {
			validateUnicode(key, pointer(p, key));
			if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key))
				invalid(pointer(p, key), 'unknown_field', `Unknown field ${key}`);
		}
		for (const [key, check] of Object.entries(required)) {
			if (!Object.hasOwn(o, key))
				invalid(pointer(p, key), 'missing_field', `Missing required field ${key}`);
			check(o[key], pointer(p, key));
		}
		for (const [key, check] of Object.entries(optional))
			if (Object.hasOwn(o, key)) check(o[key], pointer(p, key));
	};
const discriminated =
	(key: string, variants: Record<string, Check>): Check =>
	(v, p) => {
		const o = object(v, p);
		if (typeof o[key] !== 'string' || !Object.hasOwn(variants, o[key] as string))
			invalid(pointer(p, key), 'invalid_discriminator', `Unknown ${key}`);
		variants[o[key] as string](v, p);
	};
const id: Check = (v, p) => {
	text(80, true)(v, p);
	if (!/^[A-Za-z0-9:_-]{1,80}$/.test(v as string))
		invalid(p, 'invalid_local_id', 'Invalid document-local ID');
};
const labelName: Check = (v, p) => {
	text(LABEL_NAME_MAX, true)(v, p);
	const name = (v as string).trim();
	if (name.startsWith('-') || /[\u0000-\u001f\u007f]/.test(name))
		invalid(
			p,
			'invalid_field',
			'Label names cannot start with a hyphen or contain control characters'
		);
};
const slug: Check = (v, p) => {
	text(100, true)(v, p);
	if (!/^[a-z0-9-]+$/.test(v as string))
		invalid(p, 'invalid_field', 'Expected a slug ([a-z0-9-]+)');
};
const bundledState = shape({ kind: oneOf(['bundled_state']), state_id: id });
const systemState = shape({
	kind: oneOf(['system_state']),
	workflow: oneOf(['Standard']),
	state_name: text(100, true)
});
const stateRef = (library: boolean): Check =>
	discriminated('kind', {
		bundled_state: bundledState,
		...(library ? { system_state: systemState } : {})
	});
const bundledWorkflow = shape({ kind: oneOf(['bundled_workflow']), workflow_id: id });
const projectRef = shape({ kind: oneOf(['input_project']), input_id: id });
const requirement: Check = (v, p) => {
	shape(
		{ artifact: slug },
		{ type: oneOf(ARTIFACT_TYPES), content_type: text(100, true), description: text(500) }
	)(v, p);
	const o = v as Record<string, unknown>;
	if (o.content_type !== undefined && o.type !== 'file' && o.type !== 'text')
		invalid(pointer(p, 'content_type'), 'invalid_field', 'content_type requires type file or text');
};
const workflow = (library: boolean): Check =>
	shape({
		id,
		name: text(200, true),
		description: text(10000),
		initial_state_id: id,
		states: array(
			shape({
				id,
				name: text(100, true),
				category: oneOf(STATE_CATEGORIES),
				inherits_from: nullable(stateRef(library))
			})
		),
		transitions: array(
			shape({
				id,
				name: text(100, true),
				from_state_id: id,
				to_state_id: id,
				requires: array(requirement)
			})
		)
	});
const workspacePath: Check = (v, p) => {
	text(500, true)(v, p);
	const path = v as string;
	if (
		path.includes('\\') ||
		path.includes('=') ||
		path.split('/').some((s) => !s || s === '.' || s === '..')
	)
		invalid(
			p,
			'invalid_path',
			'Expected a relative workspace path without empty, dot or parent segments, backslashes or equals'
		);
};
const bytes = (v: string) => new TextEncoder().encode(v).byteLength;
const prompt: Check = (v, p) => {
	text(PROMPT_MAX_BYTES)(v, p);
	if (bytes(v as string) > PROMPT_MAX_BYTES)
		invalid(p, 'package_too_large', `Prompt exceeds ${PROMPT_MAX_BYTES} UTF-8 bytes`);
};
const files: Check = (v, p) => {
	array(shape({ id, path: workspacePath, content: text(SKILL_MAX_TOTAL_BYTES) }), SKILL_MAX_FILES)(
		v,
		p
	);
	const entries = v as Array<{ path: string; content: string }>;
	const seen = new Set<string>();
	let size = 0;
	for (const [i, file] of entries.entries()) {
		if (seen.has(file.path))
			invalid(pointer(pointer(p, i), 'path'), 'duplicate_path', 'Duplicate skill file path');
		seen.add(file.path);
		size += bytes(file.path) + bytes(file.content);
	}
	if (size > SKILL_MAX_TOTAL_BYTES)
		invalid(p, 'package_too_large', `Skill exceeds ${SKILL_MAX_TOTAL_BYTES} UTF-8 bytes`);
};
const repoUrl: Check = (v, p) => {
	text(1000, true)(v, p);
	let url: URL;
	try {
		url = new URL(v as string);
	} catch {
		invalid(p, 'invalid_repo_url', 'Expected a GitHub HTTPS repository URL');
	}
	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!canonicalGitHubRepoUrl(v as string)
	)
		invalid(
			p,
			'invalid_repo_url',
			'Expected a GitHub HTTPS repository URL without credentials, query or fragment'
		);
};
const context = (library: boolean): Check => {
	const scope: Record<string, Check> = library
		? {
				scope: shape({}, { project_id: id, state: stateRef(true), label_id: id }),
				journal: bool
			}
		: { state_id: id };
	const common: Record<string, Check> = {
		id,
		name: text(100, true),
		description: text(1000),
		...scope
	};
	return (v, p) => {
		discriminated('kind', {
			prompt: shape({ ...common, kind: oneOf(['prompt']), body: prompt }),
			skill: shape({ ...common, name: slug, kind: oneOf(['skill']), files }),
			repo: shape({
				...common,
				kind: oneOf(['repo']),
				// Whole-library transfer preserves ordinary repo declarations, including
				// local/file URLs. Workflow packages are shareable and stay GitHub-only.
				repo_url: library ? text(1000, true) : repoUrl,
				repo_branch: nullable(text(200, true)),
				repo_dir: nullable(workspacePath)
			})
		})(v, p);
		const o = v as Record<string, unknown>;
		if (library && o.journal && o.kind !== 'prompt')
			invalid(pointer(p, 'journal'), 'invalid_field', 'Only prompts may be journals');
	};
};
const input: Check = (v, p) => {
	shape(
		{
			id,
			key: text(64, true),
			type: oneOf(['text', 'workflow', 'label', 'project']),
			label: text(200, true),
			description: text(1000),
			required: bool,
			default: nullable(text(10000))
		},
		{ required_states: array(text(100, true)) }
	)(v, p);
	const o = v as Record<string, unknown>;
	if (!/^[a-z][a-z0-9_]{0,63}$/.test(o.key as string))
		invalid(pointer(p, 'key'), 'invalid_input_key', 'Invalid input key');
	if (o.required_states !== undefined && o.type !== 'workflow')
		invalid(
			pointer(p, 'required_states'),
			'invalid_field',
			'Only workflow inputs may require states'
		);
};
const preset = discriminated('kind', {
	hourly: shape({ kind: oneOf(['hourly']), every_hours: integer }, { minute: integer }),
	daily: shape({ kind: oneOf(['daily']), time: text(5, true) }),
	weekly: shape({ kind: oneOf(['weekly']), time: text(5, true), weekday: integer }),
	monthly: shape({ kind: oneOf(['monthly']), time: text(5, true), day_of_month: integer })
});
const recurrence: Check = (v, p) => {
	discriminated('kind', {
		preset: shape({ kind: oneOf(['preset']), preset }),
		cron: shape({ kind: oneOf(['cron']), cron: text(100, true) })
	})(v, p);
	const o = v as { kind: string; preset: SchedulePreset; cron: string };
	try {
		validateScheduleCron(o.kind === 'preset' ? compilePreset(o.preset) : o.cron);
	} catch (e) {
		invalid(p, 'invalid_recurrence', (e as Error).message);
	}
};
const timezone: Check = (v, p) => {
	text(100, true)(v, p);
	try {
		validateTimezone(v as string);
	} catch (e) {
		invalid(p, 'invalid_timezone', (e as Error).message);
	}
};
const schedule = shape({
	id,
	workflow: bundledWorkflow,
	project: projectRef,
	name: text(200, true),
	title_template: text(500, true),
	description_template: text(100000),
	recurrence,
	timezone,
	require_all_closed: bool,
	start_state: nullable(bundledState)
});

/** Digest is checked separately, so draft authors can use an empty placeholder. */
export function validateLibraryV3Shape(value: unknown): asserts value is PortableLibraryV3Document {
	const envelope = { format: oneOf(['tines.library']), version: oneOf([3]), exported_at: integer };
	const digest: Check = (v, p) => {
		text(71)(v, p);
		if (v !== '' && !/^sha256:[0-9a-f]{64}$/.test(v as string))
			invalid(p, 'invalid_digest', 'Expected sha256 and 64 lowercase hex digits');
	};
	discriminated('profile', {
		workflow: shape(
			{
				...envelope,
				profile: oneOf(['workflow']),
				main_workflow_id: id,
				workflows: array(workflow(false)),
				context: array(context(false)),
				inputs: array(input),
				text_uses: array(
					shape({
						id,
						target: shape({
							record_id: id,
							field: oneOf([
								'description',
								'body',
								'content',
								'title_template',
								'description_template'
							])
						}),
						input_id: id,
						token: text(30100, true)
					})
				),
				schedules: array(schedule),
				routing: array(
					shape({
						id,
						scope: shape({ state_id: id }, { project: projectRef }),
						tier: oneOf(MODEL_TIERS)
					})
				)
			},
			{ digest }
		),
		library: shape(
			{
				...envelope,
				profile: oneOf(['library']),
				workflows: array(workflow(true)),
				context: array(context(true)),
				projects: array(
					shape({
						id,
						name: text(200, true),
						description: text(10000),
						default_workflow: nullable(
							discriminated('kind', {
								bundled_workflow: bundledWorkflow,
								system_workflow: shape({
									kind: oneOf(['system_workflow']),
									name: oneOf(['Standard'])
								})
							})
						)
					})
				),
				labels: array(shape({ id, name: labelName, color: oneOf(LABEL_COLORS) }))
			},
			{ digest }
		)
	})(value, '');
}
