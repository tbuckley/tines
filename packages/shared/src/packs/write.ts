/**
 * `writePackFiles`: a `PackModel` → the pack's files, the inverse of
 * `parsePack` (`parsePack(writePackFiles(m)).model` deep-equals `m`).
 *
 * YAML is written with two-space indentation, keys in the order the spec
 * shows, and no line folding. Small maps (`derived_from`, recurrences, repo
 * and env-input entries, transitions with requirements) are written in flow
 * style, as the spec's examples are. Optional files and keys that hold their
 * defaults are left out.
 */
import { Document, isCollection, isScalar } from 'yaml';
import type { ArtifactRequirement } from '../types.js';
import { PACK_PROMPT_DEFAULT_ORDER, packReachDir } from './parse.js';
import type { PackFile, PackInputDecl, PackLocation, PackModel, PackWorkflow } from './types.js';

const ENCODER = new TextEncoder();

/** UTF-8 encodes a `{ path: text }` record into pack files, sorted by path. */
export function packFilesFromRecord(record: Record<string, string>): PackFile[] {
	return Object.keys(record)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
		.map((path) => ({ path, bytes: ENCODER.encode(record[path]) }));
}

/**
 * Stringifies `value`, turning the collections at `flowPaths` into flow
 * style and double-quoting the strings at `quotePaths` (times and cron
 * expressions, which read ambiguously unquoted).
 */
function yamlText(
	value: unknown,
	flowPaths: (string | number)[][] = [],
	quotePaths: (string | number)[][] = []
): string {
	const doc = new Document(value);
	for (const path of flowPaths) {
		const node = doc.getIn(path, true);
		if (isCollection(node)) node.flow = true;
	}
	for (const path of quotePaths) {
		const node = doc.getIn(path, true);
		if (isScalar(node) && typeof node.value === 'string') node.type = 'QUOTE_DOUBLE';
	}
	return doc.toString({ indent: 2, lineWidth: 0 });
}

function inputDecl(decl: PackInputDecl): Map<string, unknown> {
	const m = new Map<string, unknown>([['type', decl.type]]);
	if (decl.description !== '') m.set('description', decl.description);
	if ((decl.type === 'text' || decl.type === 'workflow') && decl.default !== undefined) {
		m.set('default', decl.default);
	}
	if (decl.type === 'text' && decl.required !== undefined) m.set('required', decl.required);
	if (decl.type === 'repo' && decl.default_branch !== undefined) {
		m.set('default_branch', decl.default_branch);
	}
	return m;
}

function requirement(r: ArtifactRequirement): unknown {
	const keys = Object.keys(r).filter((k) => r[k as keyof ArtifactRequirement] !== undefined);
	if (keys.length === 1 && keys[0] === 'artifact') return r.artifact;
	const m = new Map<string, unknown>([['artifact', r.artifact]]);
	if (r.type !== undefined) m.set('type', r.type);
	if (r.content_type !== undefined) m.set('content_type', r.content_type);
	if (r.description !== undefined) m.set('description', r.description);
	return m;
}

function workflowYaml(wf: PackWorkflow): string {
	const flow: (string | number)[][] = [];
	const states = new Map<string, unknown>();
	for (const s of wf.states) {
		const state = new Map<string, unknown>([
			['name', s.name],
			['category', s.category]
		]);
		if (s.run_scope !== 'issue') state.set('run_scope', s.run_scope);
		if (s.transitions.length > 0) {
			const transitions = new Map<string, unknown>();
			for (const t of s.transitions) {
				if (!t.requires || t.requires.length === 0) {
					transitions.set(t.name, t.to);
				} else {
					transitions.set(
						t.name,
						new Map<string, unknown>([
							['to', t.to],
							['requires', t.requires.map(requirement)]
						])
					);
					// Flow style (`{ to: review, requires: [pull-request] }`) when
					// every requirement is a bare artifact name; block otherwise.
					if (t.requires.every((r) => typeof requirement(r) === 'string')) {
						flow.push(['states', s.key, 'transitions', t.name]);
					}
				}
			}
			state.set('transitions', transitions);
		}
		states.set(s.key, state);
	}
	const doc = new Map<string, unknown>([['name', wf.name]]);
	if (wf.description !== '') doc.set('description', wf.description);
	doc.set('initial', wf.initial);
	doc.set('states', states);
	return yamlText(doc, flow);
}

function promptText(body: string, order: number, description: string): string {
	const front = new Map<string, unknown>();
	if (order !== PACK_PROMPT_DEFAULT_ORDER) front.set('order', order);
	if (description !== '') front.set('description', description);
	// A body that itself opens with a `---` line needs (empty) frontmatter
	// in front of it, or it would be read as frontmatter.
	if (front.size === 0 && !/^---[ \t]*\r?\n/.test(body)) return body;
	return `---\n${front.size > 0 ? yamlText(front) : ''}---\n${body}`;
}

/** Groups located items by their reach folder. */
function byDir<T extends PackLocation>(items: T[]): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const item of items) {
		const dir = packReachDir(item);
		out.set(dir, [...(out.get(dir) ?? []), item]);
	}
	return out;
}

/** Writes a model as pack files (relative paths, no top-level folder), sorted by path. */
export function writePackFiles(model: PackModel): PackFile[] {
	const text: Record<string, string> = {};
	const { manifest } = model;

	const pack = new Map<string, unknown>([
		['format', manifest.format],
		['id', manifest.id],
		['name', manifest.name]
	]);
	if (manifest.version !== null) pack.set('version', manifest.version);
	if (manifest.description !== '') pack.set('description', manifest.description);
	const flow: (string | number)[][] = [];
	if (manifest.derived_from) {
		const df = new Map<string, unknown>([['id', manifest.derived_from.id]]);
		if (manifest.derived_from.version !== null) df.set('version', manifest.derived_from.version);
		pack.set('derived_from', df);
		flow.push(['derived_from']);
	}
	const inputs = Object.entries(manifest.inputs);
	if (inputs.length > 0) {
		pack.set('inputs', new Map(inputs.map(([name, decl]) => [name, inputDecl(decl)])));
	}
	text['pack.yaml'] = yamlText(pack, flow);

	if (model.readme !== null) text['README.md'] = model.readme;
	if (model.changelog !== null) text['CHANGELOG.md'] = model.changelog;

	const versions = Object.keys(model.migrations);
	if (versions.length > 0) {
		const m = new Map<string, unknown>();
		for (const v of versions.sort((a, b) => Number(a) - Number(b))) {
			const entry = model.migrations[v];
			const e = new Map<string, unknown>();
			if (Object.keys(entry.renamed).length > 0)
				e.set('renamed', new Map(Object.entries(entry.renamed)));
			if (Object.keys(entry.removed).length > 0)
				e.set('removed', new Map(Object.entries(entry.removed)));
			m.set(v, e);
		}
		text['migrations.yaml'] = yamlText(m);
	}

	for (const wf of model.workflows) {
		text[`workflows/${wf.key}/workflow.yaml`] = workflowYaml(wf);
	}

	for (const p of model.prompts) {
		text[`${packReachDir(p)}/${p.name}.md`] = promptText(p.body, p.order, p.description);
	}
	for (const s of model.skills) {
		for (const f of s.files) text[`${packReachDir(s)}/skills/${s.name}/${f.path}`] = f.content;
	}
	for (const [dir, items] of byDir(model.env)) {
		const m = new Map<string, unknown>();
		const envFlow: string[][] = [];
		for (const e of items) {
			if ('template' in e.value) m.set(e.name, e.value.template);
			else {
				m.set(e.name, new Map([['input', e.value.input]]));
				envFlow.push([e.name]);
			}
		}
		text[`${dir}/env.yaml`] = yamlText(m, envFlow);
	}
	for (const [dir, items] of byDir(model.repos)) {
		const m = new Map<string, unknown>();
		for (const r of items) {
			const entry = new Map<string, unknown>();
			if (r.input !== null) entry.set('input', r.input);
			else {
				entry.set('url', r.url);
				if (r.branch !== null) entry.set('branch', r.branch);
			}
			if (r.dir !== null) entry.set('dir', r.dir);
			m.set(r.name, entry);
		}
		text[`${dir}/repos.yaml`] = yamlText(
			m,
			items.map((r) => [r.name])
		);
	}

	for (const s of model.schedules) {
		const doc = new Map<string, unknown>([
			['name', s.name],
			['workflow', s.workflow]
		]);
		if (s.start !== null) doc.set('start', s.start);
		const r = s.recurrence;
		const recurrence =
			'cron' in r
				? new Map([['cron', r.cron]])
				: new Map<string, unknown>([
						['every', r.every],
						...(r.on !== undefined ? [['on', r.on] as [string, unknown]] : []),
						...(r.at !== undefined ? [['at', r.at] as [string, unknown]] : [])
					]);
		doc.set('recurrence', recurrence);
		if (s.only_when_previous_closed) doc.set('only_when_previous_closed', true);
		doc.set('title', s.title);
		if (s.description !== '') doc.set('description', s.description);
		text[`schedules/${s.key}.yaml`] = yamlText(
			doc,
			[['recurrence']],
			[
				['recurrence', 'cron'],
				['recurrence', 'at']
			]
		);
	}

	return packFilesFromRecord(text);
}
