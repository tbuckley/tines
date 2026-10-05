/**
 * Helpers for `tines packs` (specs/packs/MVP_SPEC.md): reading a pack from a
 * folder or a `.tinespack`, turning it into an upload, parsing the value
 * flags, and rendering reviews. The pack format itself lives in
 * `@tines/shared` (`packages/shared/src/packs/`); nothing here re-implements
 * it. Pure where it can be, so the strings the commands print can be pinned
 * by tests; the file reads are the only I/O.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	isPackClutterPath,
	PACK_ARCHIVE_MAX_BYTES,
	packDigest,
	parsePack,
	readPackArchive,
	type PackAdds,
	type PackDetail,
	type PackFile,
	type PackFileChange,
	type PackInputDecl,
	type PackInputValueInput,
	type PackInputView,
	type PackIssue,
	type PackModel,
	type PackParseResult,
	type PackRemovePreview,
	type PackReview,
	type PackSummary,
	type PackUpload
} from '@tines/shared';
import { CliError } from './errors.js';
import { runScopeLabel } from './format.js';

// ---------------------------------------------------------------------------
// Reading a pack from disk

/** A pack read from disk: its files and how to send them. */
export interface LocalPack {
	kind: 'folder' | 'archive';
	/** Normalized for a folder only after parsing; raw relative paths here. */
	files: PackFile[];
	/** Problems found while reading (symlinks, an unreadable archive, size). */
	errors: PackIssue[];
	/** What install/replace/validate send: the archive bytes, or the files. */
	upload: PackUpload;
}

const issue = (code: string, path: string | null, message: string): PackIssue => ({
	level: 'error',
	code,
	path,
	message
});

/**
 * Folder names never read as pack content. Operating-system clutter is the
 * library's rule (`isPackClutterPath`); `.git` is added here because a pack
 * kept in a git repository is the round trip the spec describes, and its
 * repository metadata is never part of the pack.
 */
const SKIPPED_FOLDERS = new Set(['.git']);

function walkFolder(root: string): { files: PackFile[]; errors: PackIssue[] } {
	const files: PackFile[] = [];
	const errors: PackIssue[] = [];
	let total = 0;
	const visit = (dir: string, rel: string) => {
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		);
		for (const entry of entries) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (isPackClutterPath(path)) continue;
			const abs = join(dir, entry.name);
			const stat = lstatSync(abs);
			if (stat.isSymbolicLink()) {
				errors.push(
					issue('symlink', path, `"${path}" is a symlink; packs cannot contain symlinks`)
				);
				continue;
			}
			if (stat.isDirectory()) {
				if (SKIPPED_FOLDERS.has(entry.name)) continue;
				visit(abs, path);
				continue;
			}
			if (!stat.isFile()) {
				errors.push(issue('invalid_path', path, `"${path}" is not a regular file`));
				continue;
			}
			total += stat.size;
			if (total > PACK_ARCHIVE_MAX_BYTES) {
				throw new CliError(
					`${root}: the pack is over ${PACK_ARCHIVE_MAX_BYTES} bytes, the most a pack can hold`
				);
			}
			files.push({ path, bytes: new Uint8Array(readFileSync(abs)) });
		}
	};
	visit(root, '');
	return { files, errors };
}

/**
 * Reads a pack folder (recursively) or a `.tinespack`/`.zip` archive. Any
 * other file is read as an archive too, and the library says why it is not
 * one. Throws a CliError when the path cannot be read at all.
 */
export function readLocalPack(path: string): LocalPack {
	let stat;
	try {
		stat = statSync(path);
	} catch (err) {
		throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (stat.isDirectory()) {
		const { files, errors } = walkFolder(path);
		return {
			kind: 'folder',
			files,
			errors,
			upload: {
				files: files.map((f) => ({
					path: f.path,
					content_b64: Buffer.from(f.bytes).toString('base64')
				}))
			}
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(path));
	} catch (err) {
		throw new CliError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const read = readPackArchive(bytes);
	return {
		kind: 'archive',
		files: read.files,
		errors: read.errors,
		upload: { archive_b64: Buffer.from(bytes).toString('base64') }
	};
}

/**
 * Validates a pack read from disk, offline, exactly as the server's upload
 * reader does: problems reading the archive or folder stop before parsing,
 * and otherwise `parsePack` decides.
 */
export async function parseLocalPack(local: LocalPack): Promise<PackParseResult> {
	if (local.errors.length > 0) {
		return {
			model: null,
			errors: local.errors,
			warnings: [],
			files: local.files,
			digest: local.files.length ? await packDigest(local.files) : ''
		};
	}
	return parsePack(local.files);
}

// ---------------------------------------------------------------------------
// Summaries

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `items: project 2, pack 5, …` counts over every context item kind. */
export function itemsByReach(model: PackModel): Record<string, number> {
	const out: Record<string, number> = { project: 0, pack: 0, workflow: 0, state: 0 };
	for (const item of [...model.prompts, ...model.skills, ...model.env, ...model.repos]) {
		out[item.reach] += 1;
	}
	return out;
}

export function issueLine(i: PackIssue): string {
	return `${i.level} ${i.path ?? '(pack)'}: ${i.message} [${i.code}]`;
}

/** The text `packs validate` prints. */
export function formatValidation(result: PackParseResult): string {
	const out: string[] = [];
	const m = result.model;
	if (m) {
		const version = m.manifest.version === null ? 'unversioned' : `version ${m.manifest.version}`;
		out.push(`valid pack ${m.manifest.id} "${m.manifest.name}" (${version})`);
	} else {
		out.push(`invalid pack: ${plural(result.errors.length, 'error')}`);
	}
	if (result.digest) out.push(`digest: ${result.digest}`);
	out.push(`files: ${result.files.length}`);
	if (m) {
		out.push(
			`workflows: ${m.workflows.length}${
				m.workflows.length
					? ` (${m.workflows.map((w) => `${w.key}: ${plural(w.states.length, 'state')}`).join(', ')})`
					: ''
			}`
		);
		const reach = itemsByReach(m);
		out.push(
			`items by reach: ${Object.entries(reach)
				.map(([k, n]) => `${k} ${n}`)
				.join(', ')}`
		);
		const inputs = Object.entries(m.manifest.inputs);
		out.push(
			`inputs: ${inputs.length}${inputs.length ? ` (${inputs.map(([n, d]) => `${n}: ${d.type}`).join(', ')})` : ''}`
		);
		out.push(
			`schedules: ${m.schedules.length}${m.schedules.length ? ` (${m.schedules.map((s) => s.key).join(', ')})` : ''}`
		);
	}
	for (const e of result.errors) out.push(issueLine(e));
	for (const w of result.warnings) out.push(issueLine(w));
	return out.join('\n');
}

/** The status badges of a pack, as `packs list` shows them. */
export function packBadges(p: PackSummary): string[] {
	const out: string[] = [];
	if (p.needs_setup.length)
		out.push(`needs setup (${p.needs_setup.map((m) => m.input).join(', ')})`);
	if (p.newer_version_available) out.push('newer version available');
	if (p.kind === 'authored' && p.changed_since_export) out.push('changed since export');
	return out;
}

export function sourceLabel(p: Pick<PackSummary, 'source'>): string {
	if (!p.source) return '-';
	if (p.source.kind === 'file') return 'file';
	return `project ${p.source.project_name ?? p.source.project_id ?? '(removed)'}`;
}

// ---------------------------------------------------------------------------
// Pack references

/**
 * Resolves `<pack>` against a project's packs: the pack row id, then the
 * `pack.yaml` id (unique per project), then the name (unique or refused).
 */
export function pickPack(items: PackSummary[], ref: string): PackSummary {
	const byId = items.find((p) => p.id === ref);
	if (byId) return byId;
	const byKey = items.filter((p) => p.pack_key === ref);
	if (byKey.length === 1) return byKey[0];
	const byName = items.filter((p) => p.name === ref);
	if (byName.length === 1) return byName[0];
	if (byKey.length + byName.length > 1) {
		throw new CliError(
			`pack "${ref}" is ambiguous; use an id: ${[...byKey, ...byName].map((p) => `${p.name} [${p.id}]`).join(', ')}`
		);
	}
	throw new CliError(
		`no pack "${ref}" in this project (have: ${items.map((p) => `${p.name} [${p.id}]`).join(', ') || 'none'})`
	);
}

// ---------------------------------------------------------------------------
// Value flags

/** Splits `name=value` (the value may itself contain `=`). */
export function splitAssignment(raw: string, flag: string, shape: string): [string, string] {
	const eq = raw.indexOf('=');
	if (eq < 1) throw new CliError(`${flag} must look like ${shape}, got "${raw}"`);
	return [raw.slice(0, eq), raw.slice(eq + 1)];
}

/** `url[#branch]` → a repo value. The server checks the URL is https. */
export function repoValue(raw: string): PackInputValueInput {
	const hash = raw.lastIndexOf('#');
	const url = hash === -1 ? raw : raw.slice(0, hash);
	const branch = hash === -1 ? null : raw.slice(hash + 1) || null;
	if (!url) throw new CliError(`a repo value needs a URL, got "${raw}"`);
	return { repo_url: url, repo_branch: branch };
}

/**
 * A workflow reference as typed: `pack:<workflow>[/<state>]` (a workflow of
 * the pack itself, by key) passes through for the server to resolve; any
 * other value is `<workflow>[/<state>]`, which the caller resolves to ids.
 */
export type WorkflowRef =
	| { kind: 'pack'; ref: string; workflow: string; state: string | null }
	| { kind: 'project'; workflow: string; state: string | null };

export function parseWorkflowRef(raw: string): WorkflowRef {
	if (raw.startsWith('pack:')) {
		const [workflow, state] = raw.slice(5).split('/');
		if (!workflow) throw new CliError(`"${raw}" names no workflow; use pack:<workflow>[/<state>]`);
		return { kind: 'pack', ref: raw, workflow, state: state || null };
	}
	const slash = raw.indexOf('/');
	if (slash === 0 || !raw) throw new CliError(`"${raw}" names no workflow`);
	return slash === -1
		? { kind: 'project', workflow: raw, state: null }
		: { kind: 'project', workflow: raw.slice(0, slash), state: raw.slice(slash + 1) || null };
}

/** Which flag sets an input of each type, for errors that name the right one. */
export const VALUE_FLAG: Record<PackInputDecl['type'], string> = {
	text: '--value',
	repo: '--repo',
	workflow: '--workflow',
	secret: '--secret'
};

/** Checks a flag's input exists and has the type the flag sets. */
export function checkInputFlag(
	inputs: Pick<PackInputView, 'name' | 'decl'>[],
	name: string,
	flag: string
): PackInputDecl {
	const input = inputs.find((i) => i.name === name);
	if (!input) {
		throw new CliError(
			`${flag} ${name}: this pack declares no input "${name}" (have: ${inputs.map((i) => `${i.name} (${i.decl.type})`).join(', ') || 'none'})`
		);
	}
	const want = VALUE_FLAG[input.decl.type];
	const flagBase = flag.replace(/-stdin$/, '');
	if (flagBase !== want) {
		throw new CliError(
			`${flag} ${name}: "${name}" is a ${input.decl.type} input; set it with ${want}`
		);
	}
	return input.decl;
}

/** `key[@timezone]` → a suggested schedule to create. */
export function parseScheduleFlag(raw: string, defaultTimezone: string) {
	const at = raw.indexOf('@');
	const key = at === -1 ? raw : raw.slice(0, at);
	const timezone = at === -1 ? defaultTimezone : raw.slice(at + 1);
	if (!key) throw new CliError(`--schedule must look like <key>[@<timezone>], got "${raw}"`);
	if (!timezone) throw new CliError(`--schedule ${key}@: the timezone is empty`);
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone });
	} catch {
		throw new CliError(`--schedule ${key}: unknown timezone "${timezone}"`);
	}
	return { key, timezone };
}

// ---------------------------------------------------------------------------
// Reviews

const section = (title: string, lines: string[], empty = 'none') =>
	[`${title}:`, ...(lines.length ? lines.map((l) => `  ${l}`) : [`  ${empty}`])].join('\n');

/** The first `max` lines of a Markdown file, noting what was left out. */
export function excerpt(text: string, max = 20): string[] {
	const lines = text.replace(/\s+$/, '').split('\n');
	if (lines.length <= max) return lines;
	return [...lines.slice(0, max), `… (${lines.length - max} more lines)`];
}

export function inputValueLabel(input: PackInputView): string {
	const v = input.value;
	if (input.decl.type === 'secret') {
		if (input.my_secret_set === undefined) return '(each person sets their own)';
		return input.my_secret_set ? 'your value is set' : 'your value is not set';
	}
	if (v) {
		if (v.type === 'text') return JSON.stringify(v.text);
		if (v.type === 'repo') return `${v.repo_url}${v.repo_branch ? `#${v.repo_branch}` : ''}`;
		if (!v.workflow_id) return '(bound workflow was removed)';
		return `${v.workflow_name ?? v.workflow_id}${v.state_name ? ` / ${v.state_name}` : ''} [${v.workflow_id}${v.state_id ? `/${v.state_id}` : ''}]`;
	}
	const d = input.decl;
	if ((d.type === 'text' || d.type === 'workflow') && d.default !== undefined)
		return `default ${JSON.stringify(d.default)}`;
	if (d.type === 'repo' && d.default_branch) return `unset (default branch ${d.default_branch})`;
	return 'unset';
}

export function inputLines(inputs: PackInputView[], willSet: Set<string> = new Set()): string[] {
	return inputs.map((i) => {
		const status = willSet.has(i.name)
			? 'set by this command'
			: i.missing
				? 'MISSING'
				: i.decl.type === 'secret'
					? 'per person'
					: 'ok';
		const required = i.decl.type === 'text' && i.decl.required === false ? ', optional' : '';
		const value = willSet.has(i.name) ? '' : `: ${inputValueLabel(i)}`;
		return `${i.name} (${i.decl.type}${required}) — ${status}${value}${i.decl.description ? `\n      ${i.decl.description}` : ''}`;
	});
}

export function addsLines(adds: PackAdds): string[] {
	const out: string[] = [];
	for (const w of adds.workflows)
		out.push(`workflow ${w.name} [${w.key}]: ${w.states.map((s) => s.name).join(' → ')}`);
	for (const i of adds.project_items)
		out.push(`project-wide ${i.kind} "${i.name}" — applies to every issue in this project`);
	for (const e of adds.env)
		out.push(
			`env ${e.name} (${e.reach}) = ${e.input !== null ? `input ${e.input}` : JSON.stringify(e.value)}`
		);
	for (const r of adds.fixed_repos)
		out.push(`fixed repo ${r.name}: ${r.url}${r.branch ? `#${r.branch}` : ''}`);
	for (const s of adds.wide_states)
		out.push(
			`${s.run_scope === 'organization' ? 'HIGH RISK: ' : ''}state ${s.workflow} / ${s.state} has run_scope ${runScopeLabel(s.run_scope)} (agents act past their own issue)`
		);
	for (const s of adds.schedules) out.push(`suggested schedule ${s.name} [${s.key}]`);
	return out;
}

function scheduleLines(model: PackModel | null): string[] {
	if (!model) return [];
	return model.schedules.map((s) => {
		const r = s.recurrence;
		const when =
			'cron' in r
				? `cron "${r.cron}"`
				: `${/^\d+h$/.test(r.every) ? `every ${r.every}` : r.every}${r.on !== undefined ? ` on ${r.on}` : ''}${r.at ? ` at ${r.at}` : ''}`;
		return `${s.key}: ${s.name} — ${s.workflow}${s.start ? `/${s.start}` : ''}, ${when} (create with --schedule ${s.key}[@<timezone>])`;
	});
}

/**
 * A line diff of two texts, unified style with three lines of context.
 * Quadratic in the line counts, so very large files are summarized instead.
 */
export function lineDiff(before: string, after: string, context = 3): string[] {
	const a = before.split('\n');
	const b = after.split('\n');
	if (a.length * b.length > 4_000_000) return ['  (too large to diff here)'];
	const n = a.length;
	const m = b.length;
	// lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
	const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	const ops: { op: ' ' | '-' | '+'; text: string; ai: number; bi: number }[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', text: a[i], ai: i++, bi: j++ });
		else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j]))
			ops.push({ op: '+', text: b[j], ai: i, bi: j++ });
		else ops.push({ op: '-', text: a[i], ai: i++, bi: j });
	}
	const out: string[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].op === ' ') {
			k++;
			continue;
		}
		const start = Math.max(0, k - context);
		let end = k;
		// Extend the hunk while changes are within 2×context of each other.
		while (end < ops.length) {
			if (ops[end].op !== ' ') {
				end++;
				continue;
			}
			let next = end;
			while (next < ops.length && ops[next].op === ' ') next++;
			if (next < ops.length && next - end <= context * 2) end = next;
			else break;
		}
		const stop = Math.min(ops.length, end + context);
		const hunk = ops.slice(start, stop);
		const aCount = hunk.filter((o) => o.op !== '+').length;
		const bCount = hunk.filter((o) => o.op !== '-').length;
		out.push(`@@ -${hunk[0].ai + 1},${aCount} +${hunk[0].bi + 1},${bCount} @@`);
		for (const o of hunk) out.push(`${o.op}${o.text}`);
		k = stop;
	}
	return out;
}

export function fileChangeLines(files: PackFileChange[], diff: boolean): string[] {
	const out: string[] = [];
	for (const f of files) {
		out.push(`${f.change} ${f.path}`);
		if (!diff) continue;
		if (f.before === undefined && f.after === undefined) {
			if (f.change === 'changed') out.push('    (binary or large file: no diff)');
			continue;
		}
		const lines = lineDiff(f.before ?? '', f.after ?? '');
		for (const l of lines) out.push(`    ${l}`);
	}
	return out;
}

export interface ReviewOptions {
	/** Inputs this invocation will set (shown as such). */
	willSet?: Set<string>;
	/** Print each changed file's diff (replace). */
	diff?: boolean;
	/** The state mapping this invocation will send (replace). */
	mapping?: Record<string, string>;
}

/** The install or replace review, in the order the spec's screens show it. */
export function formatPackReview(review: PackReview, opts: ReviewOptions = {}): string {
	const m = review.model;
	const out: string[] = [];
	const name = m ? `${m.manifest.name} (${m.manifest.id})` : 'pack';
	const version = m?.manifest.version ?? null;
	if (review.action === 'install') {
		out.push(`Install ${name}${version !== null ? ` version ${version}` : ''}`);
	} else {
		const cur = review.current;
		out.push(
			`Replace ${name}: ${cur?.kind ?? 'pack'} version ${cur?.version ?? 'none'} → ${version ?? 'unversioned'}`
		);
	}
	out.push(`digest: ${review.digest}`);
	if (review.errors.length) out.push('', section('Errors', review.errors.map(issueLine)));
	if (review.warnings.length) out.push('', section('Warnings', review.warnings.map(issueLine)));
	if (!m) return out.join('\n');

	if (review.action === 'install') {
		if (m.readme) out.push('', section('README', excerpt(m.readme)));
		if (review.adds) out.push('', section('What this pack adds', addsLines(review.adds)));
	} else {
		if (review.version_warning === 'lower_version')
			out.push('', 'WARNING: this version is lower than the one in the project.');
		if (review.version_warning === 'same_version_different_digest')
			out.push(
				'',
				'WARNING: same version number as the one in the project, but different content.'
			);
		if (review.discards_authored_edits)
			out.push(
				'',
				'WARNING: this authored pack has edits since its last export; replacing discards them.'
			);
		out.push('', section('Changelog', review.changelog ? excerpt(review.changelog, 40) : []));
		out.push(
			'',
			section(
				'Changed files',
				fileChangeLines(review.files ?? [], opts.diff === true),
				'no changes'
			)
		);
		out.push(
			'',
			section(
				'What changes in what the pack adds',
				review.adds_changed ? addsLines(review.adds_changed) : []
			)
		);
	}
	out.push(
		'',
		section(
			'Replacements',
			review.replacements.map(
				(r) =>
					`${r.kind} "${r.name}" (${r.scope_label}) ${r.direction === 'pack_overrides' ? 'is overridden by the pack' : 'overrides the pack'}`
			)
		)
	);
	out.push('', section('Inputs', inputLines(review.inputs, opts.willSet)));
	if (review.action === 'replace') {
		const rows = review.state_mapping ?? [];
		out.push(
			'',
			section(
				'State mapping (removed states that hold something)',
				rows.map((r) => {
					const target = opts.mapping?.[r.state_id] ?? r.suggested;
					return `${r.workflow_name} / ${r.state_name} [${r.state_id}] — ${r.issues} issue(s), ${r.additions} addition(s), ${r.schedules} schedule(s) → ${target ?? 'UNMAPPED (pass --map)'}${!opts.mapping?.[r.state_id] && r.suggested ? ' (suggested)' : ''}`;
				})
			)
		);
		if (rows.length && review.mapping_targets?.length)
			out.push(
				section(
					'Mapping targets',
					review.mapping_targets.map((t) => `${t.ref} — ${t.label}`)
				)
			);
	} else {
		out.push('', section('Suggested schedules', scheduleLines(m)));
	}
	return out.join('\n');
}

export function formatRemovePreview(p: PackRemovePreview): string {
	return [
		section('Blocking (move these first)', [
			...p.blocked_by.issues.map((i) => `issue ${i.ref}`),
			...p.blocked_by.schedules.map((s) => `schedule ${s.name}`)
		]),
		section(
			'Project additions deleted with the pack',
			p.additions.map((a) => `${a.kind} "${a.name}" (${a.scope_label})`)
		),
		section(
			'Inputs that become unbound in other packs',
			p.unbound_inputs.map((u) => `${u.pack_name}: ${u.input}`)
		)
	].join('\n');
}

/** `packs show`. */
export function formatPackDetail(p: PackDetail): string {
	const out: string[] = [];
	out.push(`${p.name}  [${p.id}]`);
	if (p.description) out.push(p.description);
	out.push(
		`pack id: ${p.pack_key}  kind: ${p.kind}  version: ${p.version ?? 'none'}  revision: ${p.revision}`
	);
	out.push(`source: ${sourceLabel(p)}`);
	if (p.derived_from)
		out.push(
			`derived from: ${p.derived_from.id}${p.derived_from.version !== null ? ` v${p.derived_from.version}` : ''}`
		);
	if (p.digest) out.push(`digest: ${p.digest}`);
	const badges = packBadges(p);
	if (badges.length) out.push(`status: ${badges.join('; ')}`);
	out.push('', section('Inputs', inputLines(p.inputs)));
	out.push(
		'',
		section(
			'Workflows',
			p.workflows.flatMap((w) => [
				`${w.name} [${w.key}] ${w.id} — ${plural(w.issue_count, 'issue')}`,
				...w.states.map(
					(s) =>
						`  ${s.name} [${s.key}] ${s.category}${s.run_scope !== 'issue' ? ` run_scope ${runScopeLabel(s.run_scope)}` : ''}`
				)
			])
		)
	);
	const reaches = ['project', 'pack', 'workflow', 'state'] as const;
	const byReach = reaches.flatMap((reach) => {
		const items = p.items.filter((i) => i.pack?.reach === reach);
		if (!items.length) return [];
		return [
			`${reach}:`,
			...items.map((i) => `  ${i.kind} "${i.name}" (${i.scope.label}) [${i.id}]`)
		];
	});
	out.push('', section('Items by reach', byReach));
	out.push(
		'',
		section(
			'Suggested schedules',
			p.schedules.map(
				(s) =>
					`${s.name} [${s.key}] — ${s.workflow_key}${s.start_key ? `/${s.start_key}` : ''}, ${s.recurrence_text}${s.created_schedules.length ? `; created: ${s.created_schedules.map((c) => c.name).join(', ')}` : ''}`
			)
		)
	);
	out.push('', `project additions on this pack's states: ${p.project_addition_count}`);
	return out.join('\n');
}
