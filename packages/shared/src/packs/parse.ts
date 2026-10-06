/**
 * `parsePack`: a pack's files → a validated `PackModel`
 * (specs/packs/MVP_SPEC.md, "Folder layout", "File formats", "Placeholders").
 *
 * Every problem is collected as a `PackIssue` rather than thrown: errors make
 * the model null, warnings (unknown keys, dead-end states, a `shared/` folder
 * with no workflows) do not.
 *
 * YAML is read as YAML 1.2 with the core schema and unique keys. Maps are
 * read in document order (as `Map`s), so states, transitions and inputs keep
 * the order they are written in even when a key looks like a number.
 */
import { parseDocument } from 'yaml';
import {
	ARTIFACT_NAME_PATTERN,
	ARTIFACT_TYPES,
	CONTEXT_DESCRIPTION_MAX_LENGTH,
	CONTEXT_NAME_MAX_LENGTH,
	ENV_NAME_PATTERN,
	ENV_RESERVED_NAMES,
	ENV_RESERVED_PREFIX,
	ENV_VALUE_MAX_BYTES,
	JOURNAL_NAME,
	PROMPT_MAX_BYTES,
	SKILL_MAX_FILES,
	SKILL_MAX_TOTAL_BYTES,
	SKILL_NAME_PATTERN,
	STATE_CATEGORIES,
	type ArtifactRequirement,
	type ArtifactType,
	type StateCategory
} from '../types.js';
import { normalizePackFiles, packDigest } from './archive.js';
import { scanPlaceholders } from './placeholders.js';
import { compilePackRecurrence } from './recurrence.js';
import {
	PACK_FORMAT,
	PACK_ID_PATTERN,
	PACK_INPUT_NAME_PATTERN,
	PACK_INPUT_TYPES,
	PACK_KEY_PATTERN,
	PACK_REACHES,
	PACK_RUN_SCOPES,
	PACK_TEXT_FILE_MAX_BYTES,
	type PackEnv,
	type PackFile,
	type PackInputDecl,
	type PackInputType,
	type PackIssue,
	type PackLocation,
	type PackManifest,
	type PackMigrationEntry,
	type PackModel,
	type PackParseResult,
	type PackPrompt,
	type PackRecurrence,
	type PackRepo,
	type PackRunScope,
	type PackSchedule,
	type PackSkill,
	type PackSkillFile,
	type PackState,
	type PackWorkflow
} from './types.js';

/** The default prompt `order`. */
export const PACK_PROMPT_DEFAULT_ORDER = 100;

// ---------------------------------------------------------------------------
// Helpers shared with write.ts

/** The folder (relative to the pack root) that holds items of a location. */
export function packReachDir(loc: PackLocation): string {
	switch (loc.reach) {
		case 'project':
			return 'project';
		case 'pack':
			return 'shared';
		case 'workflow':
			return `workflows/${loc.workflow}`;
		case 'state':
			return `workflows/${loc.workflow}/states/${loc.state}`;
	}
}

/**
 * Splits leading `---` frontmatter from a Markdown file. `front` is null
 * when there is none; the whole result is null when an opening `---` line
 * is never closed. The body is everything after the closing line, as is.
 */
export function splitPackFrontmatter(text: string): { front: string | null; body: string } | null {
	const open = /^---[ \t]*\r?\n/.exec(text);
	if (!open) return { front: null, body: text };
	const close = /^---[ \t]*(?:\r?\n|$)/gm;
	close.lastIndex = open[0].length;
	const m = close.exec(text);
	if (!m) return null;
	return { front: text.slice(open[0].length, m.index), body: text.slice(m.index + m[0].length) };
}

const comparePaths = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Model order: reach (project, pack, workflow, state), workflow key, state key, then name. */
export function comparePackLocated(
	a: PackLocation & { name: string },
	b: PackLocation & { name: string }
): number {
	return (
		PACK_REACHES.indexOf(a.reach) - PACK_REACHES.indexOf(b.reach) ||
		comparePaths(a.workflow ?? '', b.workflow ?? '') ||
		comparePaths(a.state ?? '', b.state ?? '') ||
		comparePaths(a.name, b.name)
	);
}

// ---------------------------------------------------------------------------
// Internals

const TEXT = new TextDecoder('utf-8', { fatal: true });
const TEXT_KEEP_BOM = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();
const byteLength = (s: string) => ENCODER.encode(s).length;

type YamlMap = Map<unknown, unknown>;
const isMap = (v: unknown): v is YamlMap => v instanceof Map;
const entriesOf = (m: YamlMap): [string, unknown][] =>
	[...m.entries()].map(([k, v]) => [String(k), v]);
const isPositiveInt = (v: unknown): v is number =>
	typeof v === 'number' && Number.isInteger(v) && v > 0;
const describe = (v: unknown) =>
	v === null ? 'null' : Array.isArray(v) ? 'a list' : isMap(v) ? 'a map' : JSON.stringify(v);

class Issues {
	errors: PackIssue[] = [];
	warnings: PackIssue[] = [];
	error(code: string, path: string | null, message: string) {
		this.errors.push({ level: 'error', code, path, message });
	}
	warn(code: string, path: string | null, message: string) {
		this.warnings.push({ level: 'warning', code, path, message });
	}
	/** Warns about each key of `m` not in `allowed`. */
	unknownKeys(m: YamlMap, allowed: readonly string[], path: string, where: string) {
		for (const [k] of entriesOf(m)) {
			if (!allowed.includes(k)) {
				this.warn('unknown_key', path, `${where}: unknown key "${k}" is ignored`);
			}
		}
	}
}

/** A trimmed, non-empty name of at most `max` characters, or null. */
function cleanName(v: unknown, max = CONTEXT_NAME_MAX_LENGTH): string | null {
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t.length > 0 && t.length <= max ? t : null;
}

/** Relative-path rules the context API applies to skill files and repo dirs. */
function workspacePathProblem(p: string): string | null {
	if (p === '') return 'it is empty';
	if (p.includes('\\')) return 'use forward slashes';
	if (p.startsWith('/')) return 'paths must be relative (no leading "/")';
	if (p.includes('=')) return 'paths cannot contain "="';
	const segments = p.split('/');
	if (segments.some((s) => s === '')) return 'paths cannot have empty segments or trailing slashes';
	if (segments.some((s) => s === '..' || s === '.'))
		return 'paths cannot contain "." or ".." segments';
	return null;
}

/** The parts of a reach folder collected from the file list. */
interface ReachBucket {
	loc: PackLocation;
	dir: string;
	prompts: { name: string; path: string; bytes: Uint8Array }[];
	env: PackFile | null;
	repos: PackFile | null;
	skills: Map<string, { rel: string; path: string; bytes: Uint8Array }[]>;
}

// ---------------------------------------------------------------------------

/**
 * Parses and validates a pack. Normalizes `files` first (clutter, single top
 * folder, path rules), and returns the normalized files and their digest
 * whatever else goes wrong.
 */
export async function parsePack(input: PackFile[]): Promise<PackParseResult> {
	const normalized = normalizePackFiles(input);
	const files = normalized.files;
	const issues = new Issues();
	issues.errors.push(...normalized.errors);
	const model = parseNormalized(files, issues);
	const digest = await packDigest(files);
	return {
		model: issues.errors.length === 0 ? model : null,
		errors: issues.errors,
		warnings: issues.warnings,
		files,
		digest
	};
}

function parseNormalized(files: PackFile[], issues: Issues): PackModel | null {
	const readText = (f: PackFile, cap: number | null = PACK_TEXT_FILE_MAX_BYTES): string | null => {
		if (cap !== null && f.bytes.length > cap) {
			issues.error('file_too_large', f.path, `"${f.path}" is over ${cap} bytes`);
			return null;
		}
		try {
			return TEXT.decode(f.bytes);
		} catch {
			issues.error('invalid_utf8', f.path, `"${f.path}" is not valid UTF-8 text`);
			return null;
		}
	};
	const readYaml = (f: PackFile): { ok: true; value: unknown } | { ok: false } => {
		const text = readText(f);
		if (text === null) return { ok: false };
		return parseYamlText(text, f.path, issues);
	};

	// --- pack.yaml -----------------------------------------------------------
	const manifestFile = files.find((f) => f.path === 'pack.yaml');
	let manifest: PackManifest | null = null;
	if (!manifestFile) {
		issues.error('missing_manifest', null, 'A pack needs a pack.yaml at its root');
	} else {
		const y = readYaml(manifestFile);
		if (y.ok) {
			const result = parseManifest(y.value, issues);
			if (result === 'too_new') return null;
			manifest = result;
		}
	}
	/** Placeholder and input-reference checks need the declarations; skip them when pack.yaml is broken. */
	const inputsKnown = manifest !== null;
	const inputs: Record<string, PackInputDecl> = manifest?.inputs ?? {};

	const checkPlaceholders = (text: string, path: string, where: string) => {
		if (!inputsKnown) return;
		for (const name of scanPlaceholders(text)) {
			const decl = inputs[name];
			if (!decl) {
				issues.error(
					'unknown_input',
					path,
					`${where} uses {{ inputs.${name} }}, but pack.yaml declares no input "${name}"`
				);
			} else if (decl.type === 'secret') {
				issues.error(
					'secret_placeholder',
					path,
					`${where} uses secret input "${name}" as a placeholder; a secret can only reach a run through env.yaml ({ input: ${name} })`
				);
			}
		}
	};
	const checkInputRef = (name: unknown, types: PackInputType[], path: string, where: string) => {
		if (typeof name !== 'string') {
			issues.error('invalid_input_ref', path, `${where}: "input" must be an input name`);
			return false;
		}
		if (!inputsKnown) return true;
		const decl = inputs[name];
		if (!decl) {
			issues.error(
				'unknown_input',
				path,
				`${where} names input "${name}", which pack.yaml does not declare`
			);
			return false;
		}
		if (!types.includes(decl.type)) {
			issues.error(
				'input_type_mismatch',
				path,
				`${where} names input "${name}" of type ${decl.type}; it must be ${types.join(' or ')}`
			);
			return false;
		}
		return true;
	};

	// --- classify files ------------------------------------------------------
	const buckets = new Map<string, ReachBucket>();
	const bucket = (loc: PackLocation): ReachBucket => {
		const dir = packReachDir(loc);
		let b = buckets.get(dir);
		if (!b) {
			b = { loc, dir, prompts: [], env: null, repos: null, skills: new Map() };
			buckets.set(dir, b);
		}
		return b;
	};
	const workflowFiles = new Map<string, PackFile | null>();
	const scheduleFiles: PackFile[] = [];
	let readme: string | null = null;
	let changelog: string | null = null;
	let migrationsFile: PackFile | null = null;
	let hasShared = false;

	const misplaced = (f: PackFile) => {
		if (/\.(md|yaml)$/.test(f.path)) {
			issues.error(
				'unexpected_file',
				f.path,
				`"${f.path}" is not part of the pack layout (see "Folder layout" in the pack format)`
			);
		} else {
			issues.error(
				'stray_file',
				f.path,
				`"${f.path}" is outside a skill; only .md and .yaml files are read, and other files must be inside skills/<name>/`
			);
		}
	};
	const intoReach = (f: PackFile, loc: PackLocation, rest: string[]) => {
		const b = bucket(loc);
		if (rest.length >= 3 && rest[0] === 'skills') {
			const list = b.skills.get(rest[1]) ?? [];
			list.push({ rel: rest.slice(2).join('/'), path: f.path, bytes: f.bytes });
			b.skills.set(rest[1], list);
		} else if (rest.length === 1 && rest[0] === 'env.yaml') {
			b.env = f;
		} else if (rest.length === 1 && rest[0] === 'repos.yaml') {
			b.repos = f;
		} else if (rest.length === 1 && rest[0].endsWith('.md')) {
			b.prompts.push({ name: rest[0].slice(0, -3), path: f.path, bytes: f.bytes });
		} else {
			misplaced(f);
		}
	};

	for (const f of files) {
		const segs = f.path.split('/');
		if (segs.length === 1) {
			if (f.path === 'pack.yaml') continue;
			if (f.path === 'README.md') readme = readText(f);
			else if (f.path === 'CHANGELOG.md') changelog = readText(f);
			else if (f.path === 'migrations.yaml') migrationsFile = f;
			else if (f.path.endsWith('.md')) {
				issues.error(
					'unexpected_file',
					f.path,
					`"${f.path}": the only Markdown files at the pack root are README.md and CHANGELOG.md; prompts go in project/, shared/ or a workflow folder`
				);
			} else misplaced(f);
			continue;
		}
		switch (segs[0]) {
			case 'project':
				intoReach(f, { reach: 'project', workflow: null, state: null }, segs.slice(1));
				break;
			case 'shared':
				hasShared = true;
				intoReach(f, { reach: 'pack', workflow: null, state: null }, segs.slice(1));
				break;
			case 'workflows': {
				if (segs.length < 3) {
					misplaced(f);
					break;
				}
				const wf = segs[1];
				if (!workflowFiles.has(wf)) workflowFiles.set(wf, null);
				if (segs.length === 3 && segs[2] === 'workflow.yaml') {
					workflowFiles.set(wf, f);
				} else if (segs[2] === 'states' && segs.length >= 5) {
					intoReach(f, { reach: 'state', workflow: wf, state: segs[3] }, segs.slice(4));
				} else {
					intoReach(f, { reach: 'workflow', workflow: wf, state: null }, segs.slice(2));
				}
				break;
			}
			case 'schedules':
				if (segs.length === 2 && f.path.endsWith('.yaml')) scheduleFiles.push(f);
				else misplaced(f);
				break;
			default:
				misplaced(f);
		}
	}

	// --- workflows -----------------------------------------------------------
	const workflows: PackWorkflow[] = [];
	/** State keys per workflow key; null when workflow.yaml could not be read. */
	const stateKeys = new Map<string, Set<string> | null>();
	for (const [key, f] of [...workflowFiles.entries()].sort(([a], [b]) => comparePaths(a, b))) {
		const where = `workflows/${key}`;
		if (!PACK_KEY_PATTERN.test(key)) {
			issues.error(
				'invalid_key',
				where,
				`Workflow key "${key}" must match ${PACK_KEY_PATTERN} (lowercase letters, digits and dashes, starting with a letter)`
			);
		}
		if (!f) {
			issues.error('missing_workflow_yaml', where, `${where}/ has no workflow.yaml`);
			stateKeys.set(key, null);
			continue;
		}
		const y = readYaml(f);
		if (!y.ok) {
			stateKeys.set(key, null);
			continue;
		}
		const wf = parseWorkflow(key, y.value, f.path, issues);
		stateKeys.set(key, wf ? new Set(wf.states.map((s) => s.key)) : null);
		if (wf) workflows.push(wf);
	}
	if (hasShared && workflowFiles.size === 0) {
		issues.warn(
			'shared_without_workflows',
			'shared',
			'shared/ has pack reach, which applies to issues in this pack’s workflows, but the pack has none; move it to project/ or add a workflow'
		);
	}

	// --- reach folders -------------------------------------------------------
	const prompts: PackPrompt[] = [];
	const skills: PackSkill[] = [];
	const env: PackEnv[] = [];
	const repos: PackRepo[] = [];
	for (const b of [...buckets.values()].sort((x, y) => comparePaths(x.dir, y.dir))) {
		const { loc } = b;
		if (loc.reach === 'state') {
			const keys = stateKeys.get(loc.workflow!);
			if (!PACK_KEY_PATTERN.test(loc.state!)) {
				issues.error(
					'invalid_key',
					b.dir,
					`State key "${loc.state}" must match ${PACK_KEY_PATTERN}`
				);
			} else if (keys && !keys.has(loc.state!)) {
				issues.error(
					'unknown_state_folder',
					b.dir,
					`${b.dir}/ is for state "${loc.state}", which workflows/${loc.workflow}/workflow.yaml does not list`
				);
			}
		}

		for (const p of b.prompts) {
			const prompt = parsePrompt(p, loc, issues);
			if (prompt) {
				checkPlaceholders(prompt.body, p.path, `Prompt "${prompt.name}"`);
				prompts.push(prompt);
			}
		}
		for (const [name, list] of [...b.skills.entries()].sort(([x], [y]) => comparePaths(x, y))) {
			const skill = parseSkill(name, list, b.dir, loc, issues);
			if (!skill) continue;
			for (const sf of skill.files) {
				if (sf.path.endsWith('.md')) {
					checkPlaceholders(sf.content, `${b.dir}/skills/${name}/${sf.path}`, `Skill "${name}"`);
				}
			}
			skills.push(skill);
		}
		if (b.env) {
			const y = readYaml(b.env);
			if (y.ok) {
				for (const item of parseEnv(y.value, b.env.path, loc, issues, checkInputRef)) {
					if ('template' in item.value) {
						checkPlaceholders(item.value.template, b.env.path, `Env "${item.name}"`);
					}
					env.push(item);
				}
			}
		}
		if (b.repos) {
			const y = readYaml(b.repos);
			if (y.ok) repos.push(...parseRepos(y.value, b.repos.path, loc, issues, checkInputRef));
		}
	}

	// --- schedules -----------------------------------------------------------
	const schedules: PackSchedule[] = [];
	for (const f of scheduleFiles) {
		const y = readYaml(f);
		if (!y.ok) continue;
		const s = parseSchedule(
			f.path.slice('schedules/'.length, -'.yaml'.length),
			y.value,
			f.path,
			issues,
			stateKeys
		);
		if (s) {
			checkPlaceholders(s.title, f.path, `Schedule "${s.key}" title`);
			checkPlaceholders(s.description, f.path, `Schedule "${s.key}" description`);
			schedules.push(s);
		}
	}

	// --- migrations ----------------------------------------------------------
	let migrations: Record<string, PackMigrationEntry> = {};
	if (migrationsFile) {
		const y = readYaml(migrationsFile);
		if (y.ok) migrations = parseMigrations(y.value, migrationsFile.path, issues);
	}

	// --- workflow input defaults (need the workflows) ------------------------
	for (const [name, decl] of Object.entries(inputs)) {
		if (decl.type !== 'workflow' || decl.default === undefined) continue;
		const [wf, state, ...extra] = decl.default.split('/');
		const keys = stateKeys.get(wf);
		if (
			extra.length > 0 ||
			keys === undefined ||
			(state !== undefined && keys !== null && !keys.has(state))
		) {
			issues.error(
				'unknown_workflow',
				'pack.yaml',
				`Input "${name}" defaults to "${decl.default}", which is not <workflow> or <workflow>/<state> for a workflow in this pack`
			);
		}
	}

	// Names are unique per kind per reach folder by construction (file and
	// folder names, unique YAML keys); this guards the model invariant.
	for (const [kind, list] of [
		['prompt', prompts],
		['skill', skills],
		['env', env],
		['repo', repos]
	] as const) {
		const seen = new Set<string>();
		for (const item of list) {
			const id = `${packReachDir(item)}\0${item.name}`;
			if (seen.has(id)) {
				issues.error(
					'duplicate_name',
					packReachDir(item),
					`Two ${kind} items in ${packReachDir(item)}/ are named "${item.name}"`
				);
			}
			seen.add(id);
		}
	}

	if (!manifest) return null;
	return {
		manifest,
		readme,
		changelog,
		migrations,
		workflows: workflows.sort((a, b) => comparePaths(a.key, b.key)),
		prompts: prompts.sort(comparePackLocated),
		skills: skills.sort(comparePackLocated),
		env: env.sort(comparePackLocated),
		repos: repos.sort(comparePackLocated),
		schedules: schedules.sort((a, b) => comparePaths(a.key, b.key))
	};
}

// ---------------------------------------------------------------------------
// YAML

function parseYamlText(
	text: string,
	path: string,
	issues: Issues
): { ok: true; value: unknown } | { ok: false } {
	const doc = parseDocument(text, {
		version: '1.2',
		schema: 'core',
		uniqueKeys: true,
		prettyErrors: true
	});
	if (doc.errors.length > 0) {
		for (const e of doc.errors) issues.error('invalid_yaml', path, `${path}: ${e.message}`);
		return { ok: false };
	}
	try {
		return { ok: true, value: doc.toJS({ mapAsMap: true, maxAliasCount: 100 }) };
	} catch (e) {
		issues.error('invalid_yaml', path, `${path}: ${e instanceof Error ? e.message : String(e)}`);
		return { ok: false };
	}
}

// ---------------------------------------------------------------------------
// pack.yaml

const MANIFEST_KEYS = ['format', 'id', 'name', 'version', 'description', 'derived_from', 'inputs'];
const P = 'pack.yaml';

function parseManifest(v: unknown, issues: Issues): PackManifest | 'too_new' | null {
	if (!isMap(v)) {
		issues.error('invalid_manifest', P, 'pack.yaml must be a map');
		return null;
	}
	const before = issues.errors.length;
	const format = v.get('format');
	if (!Number.isInteger(format) || (format as number) < 1) {
		issues.error(
			'invalid_format',
			P,
			`"format" must be a positive integer (this Tines reads ${PACK_FORMAT}); got ${describe(format)}`
		);
	} else if ((format as number) > PACK_FORMAT) {
		issues.error(
			'format_too_new',
			P,
			`This pack uses format ${format}; this Tines reads format ${PACK_FORMAT} and older. Update Tines to install it.`
		);
		return 'too_new';
	}
	issues.unknownKeys(v, MANIFEST_KEYS, P, 'pack.yaml');

	const id = v.get('id');
	if (typeof id !== 'string' || !PACK_ID_PATTERN.test(id)) {
		issues.error('invalid_id', P, `"id" must match ${PACK_ID_PATTERN}; got ${describe(id)}`);
	}
	const name = cleanName(v.get('name'));
	if (name === null) {
		issues.error(
			'invalid_name',
			P,
			`"name" must be non-empty text of at most ${CONTEXT_NAME_MAX_LENGTH} characters`
		);
	}
	const version = v.get('version');
	if (version !== undefined && version !== null && !isPositiveInt(version)) {
		issues.error(
			'invalid_version',
			P,
			`"version" must be a positive integer; got ${describe(version)}`
		);
	}
	const description = v.get('description') ?? '';
	if (typeof description !== 'string') {
		issues.error('invalid_manifest', P, '"description" must be text');
	}

	let derivedFrom: PackManifest['derived_from'] = null;
	const df = v.get('derived_from');
	if (df !== undefined && df !== null) {
		if (!isMap(df)) {
			issues.error('invalid_manifest', P, '"derived_from" must be { id, version }');
		} else {
			issues.unknownKeys(df, ['id', 'version'], P, 'derived_from');
			const dfId = df.get('id');
			const dfVersion = df.get('version') ?? null;
			if (typeof dfId !== 'string' || !PACK_ID_PATTERN.test(dfId)) {
				issues.error('invalid_manifest', P, `"derived_from.id" must match ${PACK_ID_PATTERN}`);
			} else if (dfVersion !== null && !isPositiveInt(dfVersion)) {
				issues.error('invalid_manifest', P, '"derived_from.version" must be a positive integer');
			} else {
				derivedFrom = { id: dfId, version: dfVersion as number | null };
			}
		}
	}

	const inputs: Record<string, PackInputDecl> = {};
	const rawInputs = v.get('inputs');
	if (rawInputs !== undefined && rawInputs !== null) {
		if (!isMap(rawInputs)) {
			issues.error('invalid_manifest', P, '"inputs" must be a map of input name to declaration');
		} else {
			for (const [inputName, raw] of entriesOf(rawInputs)) {
				const decl = parseInputDecl(inputName, raw, issues);
				if (decl) inputs[inputName] = decl;
			}
		}
	}

	if (issues.errors.length > before) return null;
	return {
		format: format as number,
		id: id as string,
		name: name!,
		version: (version ?? null) as number | null,
		description: description as string,
		derived_from: derivedFrom,
		inputs
	};
}

function parseInputDecl(name: string, raw: unknown, issues: Issues): PackInputDecl | null {
	const where = `Input "${name}"`;
	if (!PACK_INPUT_NAME_PATTERN.test(name)) {
		issues.error(
			'invalid_input_name',
			P,
			`${where}: input names must match ${PACK_INPUT_NAME_PATTERN}`
		);
		return null;
	}
	if (!isMap(raw)) {
		issues.error('invalid_input', P, `${where} must be a map with "type" and "description"`);
		return null;
	}
	const type = raw.get('type');
	if (typeof type !== 'string' || !(PACK_INPUT_TYPES as readonly string[]).includes(type)) {
		issues.error(
			'invalid_input',
			P,
			`${where}: "type" must be one of ${PACK_INPUT_TYPES.join(', ')}; got ${describe(type)}`
		);
		return null;
	}
	const description = raw.get('description') ?? '';
	if (typeof description !== 'string') {
		issues.error('invalid_input', P, `${where}: "description" must be text`);
		return null;
	}
	const def = raw.get('default');
	switch (type as PackInputType) {
		case 'text': {
			issues.unknownKeys(raw, ['type', 'description', 'default', 'required'], P, where);
			const required = raw.get('required');
			if (def !== undefined && typeof def !== 'string') {
				issues.error('invalid_input', P, `${where}: "default" must be text (quote it)`);
				return null;
			}
			if (required !== undefined && typeof required !== 'boolean') {
				issues.error('invalid_input', P, `${where}: "required" must be true or false`);
				return null;
			}
			return {
				type: 'text',
				description,
				...(def !== undefined ? { default: def as string } : {}),
				...(required !== undefined ? { required: required as boolean } : {})
			};
		}
		case 'secret':
			if (raw.has('default')) {
				issues.error(
					'secret_default',
					P,
					`${where} is a secret and cannot have a default; each contributor supplies their own value`
				);
				return null;
			}
			issues.unknownKeys(raw, ['type', 'description'], P, where);
			return { type: 'secret', description };
		case 'repo': {
			if (raw.has('default')) {
				issues.error(
					'repo_default',
					P,
					`${where} is a repo input; its URL never has a default (use "default_branch" for the branch)`
				);
				return null;
			}
			issues.unknownKeys(raw, ['type', 'description', 'default_branch'], P, where);
			const branch = raw.get('default_branch');
			if (branch !== undefined && typeof branch !== 'string') {
				issues.error('invalid_input', P, `${where}: "default_branch" must be text`);
				return null;
			}
			return {
				type: 'repo',
				description,
				...(branch !== undefined ? { default_branch: branch as string } : {})
			};
		}
		case 'workflow':
			issues.unknownKeys(raw, ['type', 'description', 'default'], P, where);
			if (def !== undefined && typeof def !== 'string') {
				issues.error(
					'invalid_input',
					P,
					`${where}: "default" must be <workflow> or <workflow>/<state>`
				);
				return null;
			}
			return {
				type: 'workflow',
				description,
				...(def !== undefined ? { default: def as string } : {})
			};
	}
}

// ---------------------------------------------------------------------------
// workflow.yaml

const WORKFLOW_KEYS = ['name', 'description', 'initial', 'states'];
const STATE_KEYS = ['name', 'category', 'run_scope', 'transitions'];

function parseWorkflow(key: string, v: unknown, path: string, issues: Issues): PackWorkflow | null {
	const before = issues.errors.length;
	if (!isMap(v)) {
		issues.error(
			'invalid_workflow',
			path,
			'workflow.yaml must be a map with name, initial and states'
		);
		return null;
	}
	issues.unknownKeys(v, WORKFLOW_KEYS, path, 'workflow.yaml');
	const name = cleanName(v.get('name'));
	if (name === null) {
		issues.error(
			'invalid_workflow',
			path,
			`"name" must be non-empty text of at most ${CONTEXT_NAME_MAX_LENGTH} characters`
		);
	}
	const description = v.get('description') ?? '';
	if (typeof description !== 'string') {
		issues.error('invalid_workflow', path, '"description" must be text');
	}
	const rawStates = v.get('states');
	if (!isMap(rawStates) || rawStates.size === 0) {
		issues.error(
			'invalid_workflow',
			path,
			'"states" must be a non-empty map of state key to state'
		);
		return null;
	}

	const states: PackState[] = [];
	const foldedKeys = new Set<string>();
	const names = new Set<string>();
	const rawTransitions: [PackState, unknown][] = [];
	for (const [stateKey, raw] of entriesOf(rawStates)) {
		const where = `State "${stateKey}"`;
		if (!PACK_KEY_PATTERN.test(stateKey)) {
			issues.error('invalid_key', path, `${where}: state keys must match ${PACK_KEY_PATTERN}`);
			continue;
		}
		if (foldedKeys.has(stateKey.toLowerCase())) {
			issues.error('duplicate_key', path, `${where} is listed more than once`);
			continue;
		}
		foldedKeys.add(stateKey.toLowerCase());
		if (!isMap(raw)) {
			issues.error('invalid_state', path, `${where} must be a map with name and category`);
			continue;
		}
		if (raw.has('inherits_from')) {
			issues.error(
				'inherits_from',
				path,
				`${where}: packs do not carry state inheritance; give the state its own context instead of "inherits_from"`
			);
		}
		issues.unknownKeys(raw, [...STATE_KEYS, 'inherits_from'], path, where);
		const stateName = cleanName(raw.get('name'));
		if (stateName === null) {
			issues.error(
				'invalid_state',
				path,
				`${where}: "name" must be non-empty text of at most ${CONTEXT_NAME_MAX_LENGTH} characters`
			);
		} else if (names.has(stateName)) {
			issues.error(
				'duplicate_state_name',
				path,
				`Two states are named "${stateName}"; state names must be unique within a workflow`
			);
		} else {
			names.add(stateName);
		}
		const category = raw.get('category');
		if (
			typeof category !== 'string' ||
			!(STATE_CATEGORIES as readonly string[]).includes(category)
		) {
			issues.error(
				'invalid_category',
				path,
				`${where}: "category" must be one of ${STATE_CATEGORIES.join(', ')}; got ${describe(category)}`
			);
		}
		const runScope = raw.get('run_scope') ?? 'issue';
		if (runScope === 'workspace') {
			issues.error(
				'workspace_run_scope',
				path,
				`${where}: the pack format writes the workspace run scope as "organization"`
			);
		} else if (
			typeof runScope !== 'string' ||
			!(PACK_RUN_SCOPES as readonly string[]).includes(runScope)
		) {
			issues.error(
				'invalid_run_scope',
				path,
				`${where}: "run_scope" must be one of ${PACK_RUN_SCOPES.join(', ')}; got ${describe(runScope)}`
			);
		}
		const state: PackState = {
			key: stateKey,
			name: stateName ?? '',
			category: category as StateCategory,
			run_scope: runScope as PackRunScope,
			transitions: []
		};
		states.push(state);
		rawTransitions.push([state, raw.get('transitions')]);
	}

	const keys = new Set(states.map((s) => s.key));
	for (const [state, raw] of rawTransitions) {
		const where = `State "${state.key}"`;
		if (raw === undefined || raw === null) continue;
		if (!isMap(raw)) {
			issues.error(
				'invalid_transition',
				path,
				`${where}: "transitions" must be a map of transition name to target`
			);
			continue;
		}
		const seen = new Set<string>();
		for (const [rawName, t] of entriesOf(raw)) {
			const tName = cleanName(rawName);
			const tWhere = `${where}, transition "${rawName}"`;
			if (tName === null) {
				issues.error(
					'invalid_transition',
					path,
					`${tWhere}: names must be non-empty and at most ${CONTEXT_NAME_MAX_LENGTH} characters`
				);
				continue;
			}
			if (seen.has(tName.toLowerCase())) {
				issues.error(
					'duplicate_transition',
					path,
					`${where} has more than one transition named "${tName}"`
				);
				continue;
			}
			seen.add(tName.toLowerCase());
			let to: unknown;
			let requires: ArtifactRequirement[] | undefined;
			if (typeof t === 'string') {
				to = t;
			} else if (isMap(t)) {
				issues.unknownKeys(t, ['to', 'requires'], path, tWhere);
				to = t.get('to');
				requires = parseRequirements(t.get('requires'), path, tWhere, issues);
			} else {
				issues.error(
					'invalid_transition',
					path,
					`${tWhere} must be a state key or { to, requires }`
				);
				continue;
			}
			if (typeof to !== 'string' || !keys.has(to)) {
				issues.error(
					'unknown_state',
					path,
					`${tWhere} goes to ${describe(to)}, which is not a state of this workflow`
				);
				continue;
			}
			if (to === state.key) {
				issues.error(
					'self_transition',
					path,
					`${tWhere} loops onto its own state; self-transitions are not allowed`
				);
				continue;
			}
			state.transitions.push({ name: tName, to, ...(requires ? { requires } : {}) });
		}
	}
	for (const state of states) {
		if (
			state.category !== 'done' &&
			state.transitions.length === 0 &&
			STATE_CATEGORIES.includes(state.category)
		) {
			issues.warn(
				'dead_end_state',
				path,
				`State "${state.key}" is not a done state but has no transitions out`
			);
		}
	}

	const initial = v.get('initial');
	const initialState = states.find((s) => s.key === initial);
	if (typeof initial !== 'string' || !initialState) {
		issues.error(
			'invalid_initial_state',
			path,
			`"initial" must be a state key of this workflow; got ${describe(initial)}`
		);
	} else if (initialState.category !== 'backlog' && initialState.category !== 'active') {
		issues.error(
			'invalid_initial_state',
			path,
			`The initial state must be categorized "backlog" or "active" (got "${initialState.category}" on "${initialState.key}")`
		);
	}

	if (issues.errors.length > before) {
		// Still report the state keys so state folders and schedules are checked against them.
		return { key, name: name ?? '', description: '', initial: String(initial), states };
	}
	return {
		key,
		name: name!,
		description: description as string,
		initial: initial as string,
		states
	};
}

/**
 * Transition requirements, validated as the workflows API's
 * `resolveRequirements` does. A bare string `x` in the list is shorthand for
 * `{ artifact: x }` — the spec's `requires: [pull_request]` lists artifact
 * names — and a map takes the API's own fields (`artifact`, `type`,
 * `content_type`, `description`). An empty list is no requirement.
 */
function parseRequirements(
	raw: unknown,
	path: string,
	where: string,
	issues: Issues
): ArtifactRequirement[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw)) {
		issues.error(
			'invalid_requirement',
			path,
			`${where}: "requires" must be a list of artifact names`
		);
		return undefined;
	}
	if (raw.length === 0) return undefined;
	const out: ArtifactRequirement[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		let r: ArtifactRequirement;
		if (typeof item === 'string') {
			r = { artifact: item.trim() };
		} else if (isMap(item)) {
			issues.unknownKeys(
				item,
				['artifact', 'type', 'content_type', 'description'],
				path,
				`${where} requirement`
			);
			const artifact = item.get('artifact');
			if (typeof artifact !== 'string') {
				issues.error(
					'invalid_requirement',
					path,
					`${where}: each requirement needs an "artifact" name`
				);
				continue;
			}
			r = { artifact: artifact.trim() };
			const type = item.get('type');
			if (type !== undefined) {
				if (typeof type !== 'string' || !(ARTIFACT_TYPES as readonly string[]).includes(type)) {
					issues.error(
						'invalid_requirement',
						path,
						`${where}: requirement type must be one of ${ARTIFACT_TYPES.join(', ')}; got ${describe(type)}`
					);
					continue;
				}
				r.type = type as ArtifactType;
			}
			const contentType = item.get('content_type');
			if (contentType !== undefined) {
				if (
					typeof contentType !== 'string' ||
					contentType.trim() === '' ||
					contentType.length > 100
				) {
					issues.error(
						'invalid_requirement',
						path,
						`${where}: "content_type" must be text of at most 100 characters`
					);
					continue;
				}
				if (r.type !== 'file' && r.type !== 'text') {
					issues.error(
						'invalid_requirement',
						path,
						`${where}: "content_type" only applies with type "file" or "text"`
					);
					continue;
				}
				r.content_type = contentType.trim();
			}
			const description = item.get('description');
			if (description !== undefined) {
				if (typeof description !== 'string' || description.length > 500) {
					issues.error(
						'invalid_requirement',
						path,
						`${where}: requirement "description" must be text of at most 500 characters`
					);
					continue;
				}
				if (description.trim()) r.description = description.trim();
			}
		} else {
			issues.error('invalid_requirement', path, `${where}: each requirement is an artifact name`);
			continue;
		}
		if (r.artifact.length > 100 || !ARTIFACT_NAME_PATTERN.test(r.artifact)) {
			issues.error(
				'invalid_requirement',
				path,
				`${where}: "${r.artifact}" must be a slug-like artifact name ([a-z0-9-]+)`
			);
			continue;
		}
		if (seen.has(r.artifact)) {
			issues.error(
				'invalid_requirement',
				path,
				`${where} requires artifact "${r.artifact}" more than once`
			);
			continue;
		}
		seen.add(r.artifact);
		out.push(r);
	}
	return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Prompts and skills

function parsePrompt(
	p: { name: string; path: string; bytes: Uint8Array },
	loc: PackLocation,
	issues: Issues
): PackPrompt | null {
	const name = cleanName(p.name);
	if (name === null || name !== p.name) {
		issues.error(
			'invalid_name',
			p.path,
			`Prompt file names must be 1-${CONTEXT_NAME_MAX_LENGTH} characters with no surrounding spaces`
		);
		return null;
	}
	if (name === JOURNAL_NAME) {
		issues.error(
			'reserved_prompt_name',
			p.path,
			'A pack cannot contain a prompt named "journal": journals belong to one project'
		);
		return null;
	}
	if (p.bytes.length > PACK_TEXT_FILE_MAX_BYTES) {
		issues.error(
			'prompt_too_large',
			p.path,
			`"${p.path}" is over ${PACK_TEXT_FILE_MAX_BYTES} bytes`
		);
		return null;
	}
	let text: string;
	try {
		text = TEXT.decode(p.bytes);
	} catch {
		issues.error('invalid_utf8', p.path, `"${p.path}" is not valid UTF-8 text`);
		return null;
	}
	const split = splitPackFrontmatter(text);
	if (!split) {
		issues.error(
			'invalid_frontmatter',
			p.path,
			'The frontmatter that opens with "---" is never closed'
		);
		return null;
	}
	let order = PACK_PROMPT_DEFAULT_ORDER;
	let description = '';
	if (split.front !== null) {
		const y = parseYamlText(split.front, p.path, issues);
		if (!y.ok) return null;
		if (y.value !== null && !isMap(y.value)) {
			issues.error('invalid_frontmatter', p.path, 'Frontmatter must be a map');
			return null;
		}
		if (isMap(y.value)) {
			issues.unknownKeys(y.value, ['order', 'description'], p.path, 'Prompt frontmatter');
			const o = y.value.get('order');
			if (o !== undefined) {
				if (typeof o !== 'number' || !Number.isFinite(o)) {
					issues.error(
						'invalid_frontmatter',
						p.path,
						`"order" must be a number; got ${describe(o)}`
					);
					return null;
				}
				order = o;
			}
			const d = y.value.get('description');
			if (d !== undefined) {
				if (typeof d !== 'string' || d.length > CONTEXT_DESCRIPTION_MAX_LENGTH) {
					issues.error(
						'invalid_frontmatter',
						p.path,
						`"description" must be text of at most ${CONTEXT_DESCRIPTION_MAX_LENGTH} characters`
					);
					return null;
				}
				description = d;
			}
		}
	}
	if (byteLength(split.body) > PROMPT_MAX_BYTES) {
		issues.error(
			'prompt_too_large',
			p.path,
			`A prompt body can be at most ${PROMPT_MAX_BYTES} bytes of UTF-8`
		);
		return null;
	}
	return { ...loc, name, description, order, body: split.body };
}

function parseSkill(
	name: string,
	list: { rel: string; path: string; bytes: Uint8Array }[],
	dir: string,
	loc: PackLocation,
	issues: Issues
): PackSkill | null {
	const where = `${dir}/skills/${name}`;
	const before = issues.errors.length;
	if (!SKILL_NAME_PATTERN.test(name)) {
		issues.error(
			'invalid_skill_name',
			where,
			`Skill names double as directory names and must match ${SKILL_NAME_PATTERN}; got "${name}"`
		);
		return null;
	}
	if (list.length > SKILL_MAX_FILES) {
		issues.error(
			'skill_too_large',
			where,
			`A skill can have at most ${SKILL_MAX_FILES} files (got ${list.length})`
		);
	}
	const files: PackSkillFile[] = [];
	let total = 0;
	for (const f of list) {
		const problem = workspacePathProblem(f.rel);
		if (problem) {
			issues.error('invalid_path', f.path, `"${f.rel}": ${problem}`);
			continue;
		}
		let content: string;
		try {
			content = TEXT_KEEP_BOM.decode(f.bytes);
		} catch {
			content = '\0';
		}
		if (content.includes('\0')) {
			issues.error(
				'binary_skill_file',
				f.path,
				`"${f.path}" is not UTF-8 text; Tines stores skill files as text, so binary files cannot be part of a skill`
			);
			continue;
		}
		total += f.bytes.length + byteLength(f.rel);
		files.push({ path: f.rel, content });
	}
	if (total > SKILL_MAX_TOTAL_BYTES) {
		issues.error(
			'skill_too_large',
			where,
			`A skill's files can total at most ${SKILL_MAX_TOTAL_BYTES} bytes (got ${total})`
		);
	}
	const skillMd = files.find((f) => f.path === 'SKILL.md');
	let description = '';
	if (!skillMd) {
		issues.error('missing_skill_md', where, `${where}/ has no SKILL.md`);
	} else {
		const mdPath = `${where}/SKILL.md`;
		const split = splitPackFrontmatter(skillMd.content.replace(/^﻿/, ''));
		const y = split?.front != null ? parseYamlText(split.front, mdPath, issues) : null;
		if (y === null || !y.ok || !isMap(y.value)) {
			if (y === null || y.ok) {
				issues.error(
					'invalid_frontmatter',
					mdPath,
					'SKILL.md needs frontmatter with "name" and "description"'
				);
			}
		} else {
			const fmName = y.value.get('name');
			const fmDescription = y.value.get('description');
			if (fmName !== name) {
				issues.error(
					'skill_name_mismatch',
					mdPath,
					`SKILL.md's name is ${describe(fmName)}, but its folder is "${name}"; they must match`
				);
			}
			if (typeof fmDescription !== 'string' || fmDescription.trim() === '') {
				issues.error('invalid_frontmatter', mdPath, 'SKILL.md needs a "description"');
			} else {
				description = fmDescription;
			}
		}
	}
	if (issues.errors.length > before) return null;
	return { ...loc, name, description, files };
}

// ---------------------------------------------------------------------------
// env.yaml and repos.yaml

type InputRefCheck = (
	name: unknown,
	types: PackInputType[],
	path: string,
	where: string
) => boolean;

function parseEnv(
	v: unknown,
	path: string,
	loc: PackLocation,
	issues: Issues,
	checkInputRef: InputRefCheck
): PackEnv[] {
	if (v === null) return [];
	if (!isMap(v)) {
		issues.error('invalid_env', path, 'env.yaml must be a map of variable name to value');
		return [];
	}
	const out: PackEnv[] = [];
	for (const [name, raw] of entriesOf(v)) {
		const where = `Env "${name}"`;
		if (!ENV_NAME_PATTERN.test(name)) {
			issues.error(
				'invalid_env_name',
				path,
				`${where}: env names are environment variable names (${ENV_NAME_PATTERN})`
			);
			continue;
		}
		if (name.startsWith(ENV_RESERVED_PREFIX) || ENV_RESERVED_NAMES.includes(name)) {
			issues.error(
				'reserved_env_name',
				path,
				`${where} is reserved: the runner owns ${ENV_RESERVED_PREFIX}* and ${ENV_RESERVED_NAMES.join(', ')}`
			);
			continue;
		}
		if (typeof raw === 'string') {
			if (raw.includes('\0') || byteLength(raw) > ENV_VALUE_MAX_BYTES) {
				issues.error(
					'invalid_env_value',
					path,
					`${where}: values cannot contain NUL and are at most ${ENV_VALUE_MAX_BYTES} bytes`
				);
				continue;
			}
			out.push({ ...loc, name, value: { template: raw } });
		} else if (isMap(raw) && raw.has('input')) {
			issues.unknownKeys(raw, ['input'], path, where);
			const input = raw.get('input');
			if (checkInputRef(input, ['text', 'secret'], path, where)) {
				out.push({ ...loc, name, value: { input: input as string } });
			}
		} else {
			issues.error(
				'invalid_env_value',
				path,
				`${where} must be a string (quote numbers and booleans) or { input: <name> }; got ${describe(raw)}`
			);
		}
	}
	return out;
}

function parseRepos(
	v: unknown,
	path: string,
	loc: PackLocation,
	issues: Issues,
	checkInputRef: InputRefCheck
): PackRepo[] {
	if (v === null) return [];
	if (!isMap(v)) {
		issues.error(
			'invalid_repo',
			path,
			'repos.yaml must be a map of repo name to { input } or { url }'
		);
		return [];
	}
	const out: PackRepo[] = [];
	for (const [rawName, raw] of entriesOf(v)) {
		const where = `Repo "${rawName}"`;
		// The context API's rule for repo item names: trimmed, non-empty, at most 100 characters.
		const name = cleanName(rawName);
		if (name === null || name !== rawName) {
			issues.error(
				'invalid_name',
				path,
				`${where}: names must be 1-${CONTEXT_NAME_MAX_LENGTH} characters with no surrounding spaces`
			);
			continue;
		}
		if (!isMap(raw)) {
			issues.error('invalid_repo', path, `${where} must be { input, dir } or { url, branch, dir }`);
			continue;
		}
		const input = raw.get('input');
		const url = raw.get('url');
		const branch = raw.get('branch');
		const dir = raw.get('dir');
		if ((input === undefined) === (url === undefined)) {
			issues.error(
				'invalid_repo',
				path,
				`${where} needs exactly one of "input" (a repo input) and "url" (a fixed repository)`
			);
			continue;
		}
		if (dir !== undefined) {
			const problem = typeof dir === 'string' ? workspacePathProblem(dir) : 'it must be text';
			if (problem) {
				issues.error('invalid_repo', path, `${where}: "dir" ${problem}`);
				continue;
			}
		}
		if (input !== undefined) {
			issues.unknownKeys(raw, ['input', 'dir', 'branch'], path, where);
			if (branch !== undefined) {
				issues.error(
					'invalid_repo',
					path,
					`${where} is bound to an input, which supplies the branch; remove "branch"`
				);
				continue;
			}
			if (!checkInputRef(input, ['repo'], path, where)) continue;
			out.push({
				...loc,
				name,
				input: input as string,
				url: null,
				branch: null,
				dir: (dir as string | undefined) ?? null
			});
		} else {
			issues.unknownKeys(raw, ['url', 'branch', 'dir'], path, where);
			let ok = typeof url === 'string';
			if (ok) {
				try {
					ok = new URL(url as string).protocol === 'https:';
				} catch {
					ok = false;
				}
			}
			if (!ok) {
				issues.error(
					'invalid_repo',
					path,
					`${where}: "url" must be an https:// URL; got ${describe(url)}`
				);
				continue;
			}
			if (
				branch !== undefined &&
				(typeof branch !== 'string' || branch.trim() === '' || branch.length > 200)
			) {
				issues.error(
					'invalid_repo',
					path,
					`${where}: "branch" must be text of at most 200 characters`
				);
				continue;
			}
			out.push({
				...loc,
				name,
				input: null,
				url: url as string,
				branch: (branch as string | undefined) ?? null,
				dir: (dir as string | undefined) ?? null
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// schedules/<key>.yaml

const SCHEDULE_KEYS = [
	'name',
	'workflow',
	'start',
	'recurrence',
	'only_when_previous_closed',
	'title',
	'description'
];

function parseSchedule(
	key: string,
	v: unknown,
	path: string,
	issues: Issues,
	stateKeys: Map<string, Set<string> | null>
): PackSchedule | null {
	const before = issues.errors.length;
	if (!PACK_KEY_PATTERN.test(key)) {
		issues.error(
			'invalid_key',
			path,
			`Schedule file names must match ${PACK_KEY_PATTERN}; got "${key}"`
		);
	}
	if (!isMap(v)) {
		issues.error('invalid_schedule', path, 'A schedule must be a map');
		return null;
	}
	issues.unknownKeys(v, SCHEDULE_KEYS, path, 'Schedule');
	const name = cleanName(v.get('name'));
	if (name === null)
		issues.error(
			'invalid_schedule',
			path,
			`"name" must be non-empty text of at most ${CONTEXT_NAME_MAX_LENGTH} characters`
		);
	const workflow = v.get('workflow');
	const keys = typeof workflow === 'string' ? stateKeys.get(workflow) : undefined;
	if (keys === undefined) {
		issues.error(
			'unknown_workflow',
			path,
			`"workflow" must be a workflow key in this pack; got ${describe(workflow)}`
		);
	}
	const start = v.get('start') ?? null;
	if (start !== null && (typeof start !== 'string' || (keys && !keys.has(start)))) {
		issues.error(
			'unknown_state',
			path,
			`"start" must be a state key of workflow "${String(workflow)}"; got ${describe(start)}`
		);
	}
	const onlyWhen = v.get('only_when_previous_closed') ?? false;
	if (typeof onlyWhen !== 'boolean')
		issues.error('invalid_schedule', path, '"only_when_previous_closed" must be true or false');
	const title = v.get('title');
	if (typeof title !== 'string' || title.trim() === '')
		issues.error('invalid_schedule', path, '"title" must be non-empty text');
	const description = v.get('description') ?? '';
	if (typeof description !== 'string')
		issues.error('invalid_schedule', path, '"description" must be text');

	const recurrence = parseRecurrence(v.get('recurrence'), path, issues);
	if (issues.errors.length > before || !recurrence) return null;
	return {
		key,
		name: name!,
		workflow: workflow as string,
		start: start as string | null,
		recurrence,
		only_when_previous_closed: onlyWhen as boolean,
		title: title as string,
		description: description as string
	};
}

function parseRecurrence(raw: unknown, path: string, issues: Issues): PackRecurrence | null {
	if (!isMap(raw)) {
		issues.error('invalid_recurrence', path, '"recurrence" must be { every, on, at } or { cron }');
		return null;
	}
	let r: PackRecurrence;
	if (raw.has('cron')) {
		issues.unknownKeys(raw, ['cron'], path, 'recurrence');
		if (raw.has('every') || raw.has('on') || raw.has('at')) {
			issues.error(
				'invalid_recurrence',
				path,
				'A recurrence is { cron } or { every, on, at }, not both'
			);
			return null;
		}
		r = { cron: raw.get('cron') as string };
	} else {
		issues.unknownKeys(raw, ['every', 'on', 'at'], path, 'recurrence');
		const on = raw.get('on');
		const at = raw.get('at');
		if (on !== undefined && typeof on !== 'string' && typeof on !== 'number') {
			issues.error('invalid_recurrence', path, '"on" must be a weekday or a day of the month');
			return null;
		}
		r = {
			every: raw.get('every') as Extract<PackRecurrence, { every: unknown }>['every'],
			...(on !== undefined ? { on } : {}),
			// `at: 15` (minute past the hour) reads as a number; keep it as text.
			...(at !== undefined ? { at: typeof at === 'number' ? String(at) : (at as string) } : {})
		};
	}
	try {
		compilePackRecurrence(r);
	} catch (e) {
		issues.error(
			'invalid_recurrence',
			path,
			`recurrence: ${e instanceof Error ? e.message : String(e)}`
		);
		return null;
	}
	return r;
}

// ---------------------------------------------------------------------------
// migrations.yaml

const MIGRATION_REF = /^[a-z][a-z0-9-]{0,62}(\/[a-z][a-z0-9-]{0,62})?$/;

function parseMigrations(
	v: unknown,
	path: string,
	issues: Issues
): Record<string, PackMigrationEntry> {
	const out: Record<string, PackMigrationEntry> = {};
	if (v === null) return out;
	if (!isMap(v)) {
		issues.error(
			'invalid_migration',
			path,
			'migrations.yaml must be a map of version to { renamed, removed }'
		);
		return out;
	}
	for (const [version, raw] of entriesOf(v)) {
		const where = `Version "${version}"`;
		if (!/^[1-9][0-9]*$/.test(version)) {
			issues.error(
				'invalid_migration',
				path,
				`${where}: keys are pack versions (positive integers)`
			);
			continue;
		}
		if (!isMap(raw)) {
			issues.error('invalid_migration', path, `${where} must be { renamed, removed }`);
			continue;
		}
		issues.unknownKeys(raw, ['renamed', 'removed'], path, where);
		const entry: PackMigrationEntry = { renamed: {}, removed: {} };
		for (const field of ['renamed', 'removed'] as const) {
			const m = raw.get(field);
			if (m === undefined || m === null) continue;
			if (!isMap(m)) {
				issues.error(
					'invalid_migration',
					path,
					`${where}: "${field}" must be a map of old key to new key`
				);
				continue;
			}
			for (const [from, to] of entriesOf(m)) {
				if (!MIGRATION_REF.test(from) || typeof to !== 'string' || !MIGRATION_REF.test(to)) {
					issues.error(
						'invalid_migration',
						path,
						`${where}: "${from}: ${String(to)}" — both sides must be <workflow> or <workflow>/<state> keys`
					);
					continue;
				}
				if (field === 'renamed' && from.includes('/') !== to.includes('/')) {
					issues.error(
						'invalid_migration',
						path,
						`${where}: "${from}" is renamed to "${to}"; a workflow renames to a workflow and a state to a state`
					);
					continue;
				}
				entry[field][from] = to;
			}
		}
		out[version] = entry;
	}
	return out;
}
