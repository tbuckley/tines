/**
 * `issues artifacts attach`, planned offline.
 *
 * The CLI already holds the issue's `allowed_transitions[].requires[]` by the
 * time it attaches anything (`resolveIssue` fetches the detail), so it knows
 * what each gated slot wants before it writes. This module turns that
 * knowledge into a plan: what type to create, where the bytes come from, and
 * what content type to declare — or a refusal, thrown as `CliError`, before
 * the first network write.
 *
 * Pure by design (a filesystem probe is injected), so the whole truth table —
 * gate type × flag × source shape × existing slot — is unit-testable without
 * a server; the action handler keeps every read, request and print.
 */

import {
	parsePrSpec,
	requirementFix,
	type Artifact,
	type ArtifactRequirementCheck,
	type ArtifactType,
	type IssueDetail,
	type PrRef
} from '@tines/shared';
import { existsSync, statSync } from 'node:fs';
import { CliError } from './errors.js';

/** What a path is on disk. Injected so the planner stays pure in tests. */
export type Probe = (path: string) => 'dir' | 'file' | 'missing';

export const fsProbe: Probe = (path) => {
	if (!existsSync(path)) return 'missing';
	try {
		return statSync(path).isDirectory() ? 'dir' : 'file';
	} catch {
		return 'missing';
	}
};

/** The source and modifier flags `attach` accepts (`--description` is not one: it never types). */
export interface AttachFlags {
	file?: string;
	folder?: string;
	text?: string;
	link?: string;
	pr?: string;
	contentType?: string;
	filename?: string;
	title?: string;
	ignoreGates?: boolean;
}

/** One requirement on one available transition, keeping the transition's name for messages. */
export interface GateEntry {
	transition: string;
	check: ArtifactRequirementCheck;
}

export type AttachSource =
	| { kind: 'text-inline'; value: string }
	| { kind: 'text-path'; path: string }
	| { kind: 'text-stdin' }
	| { kind: 'file-path'; path: string }
	| { kind: 'file-stdin' }
	| { kind: 'folder'; dir: string }
	| { kind: 'link'; url: string; title?: string }
	| { kind: 'pr'; pr: PrRef };

export interface AttachPlan {
	type: ArtifactType;
	source: AttachSource;
	/** Explicit `--content-type`, else the gate's concrete MIME; undefined = server default / sniff. */
	contentType?: string;
	/** `--filename` only: a positional text attach leaves the server default `<name>.md`. */
	filename?: string;
}

export interface AttachPlanInput {
	/** "Project/42", for the fix commands quoted in refusals. */
	ref: string;
	name: string;
	positional?: string;
	flags: AttachFlags;
	gates: GateEntry[];
	probe: Probe;
}

const SOURCE_FLAGS = ['--file', '--folder', '--text', '--link', '--pr'] as const;

/** Every requirement on an available transition, optionally narrowed to one slot. */
export function gatesFor(issue: IssueDetail, name?: string): GateEntry[] {
	const gates: GateEntry[] = [];
	for (const t of issue.allowed_transitions) {
		for (const check of t.requires ?? []) {
			if (name === undefined || check.artifact === name) {
				gates.push({ transition: t.name, check });
			}
		}
	}
	return gates;
}

/** The flag that would attach `type`, for "pass --text/--pr to choose"-style messages. */
function flagFor(type: ArtifactType): string {
	return type === 'file' ? '--file' : `--${type}`;
}

/** How the source arrived, named the way the refusal should quote it. */
function sourceLabel(flags: AttachFlags, positional: string | undefined): string {
	if (flags.file !== undefined) return '--file';
	if (flags.folder !== undefined) return '--folder';
	if (flags.text !== undefined) return '--text';
	if (flags.link !== undefined) return '--link';
	if (flags.pr !== undefined) return '--pr';
	return positional !== undefined ? 'the positional source' : 'the source';
}

/**
 * Exactly one content source, checked before the handler resolves the issue —
 * a mistyped invocation must die offline (Tines/92: `attach … notes --url <l>`
 * must not reach the network before commander's arity check fires).
 */
export function assertOneSource(flags: AttachFlags, positional?: string): void {
	const values = [flags.file, flags.folder, flags.text, flags.link, flags.pr];
	const given = SOURCE_FLAGS.filter((_, i) => values[i] !== undefined);
	const count = given.length + (positional !== undefined ? 1 : 0);
	if (count === 0) {
		throw new CliError(
			'pass exactly one content source: a positional <source> (a path, a URL, or owner/repo#N), --file <path>, --folder <dir>, --text <md|@file>, --link <url>, or --pr <spec> (a link goes in --link; --url is the API base URL)'
		);
	}
	if (count > 1) {
		const what = [
			...given,
			...(positional !== undefined ? [`the positional "${positional}"`] : [])
		];
		throw new CliError(`pass the source once: got ${what.join(' and ')}`);
	}
}

/** `@@x` → `@x`, `@p` → `p`; `-` and `@-` both mean stdin (readBodyValue's escape rules). */
function normalizePositional(raw: string): { value: string; stdin: boolean } {
	if (raw === '-' || raw === '@-') return { value: raw, stdin: true };
	if (raw.startsWith('@@')) return { value: raw.slice(1), stdin: false };
	if (raw.startsWith('@')) return { value: raw.slice(1), stdin: false };
	return { value: raw, stdin: false };
}

const isUrl = (v: string): boolean => /^https?:\/\//.test(v);

/** A gate's declared content type names a concrete MIME (not a `image/` prefix). */
function concreteContentType(ct: string | undefined): string | undefined {
	return ct !== undefined && ct.includes('/') && !ct.endsWith('/') ? ct : undefined;
}

/** The distinct declared types among the gates (untyped gates constrain nothing). */
function declaredTypes(gates: GateEntry[]): ArtifactType[] {
	return [
		...new Set(gates.map((g) => g.check.type).filter((t): t is ArtifactType => t !== undefined))
	];
}

/** Which of `types` a positional source's shape could plausibly be. */
function shapeCompatible(
	types: ArtifactType[],
	value: string,
	stdin: boolean,
	probe: Probe
): ArtifactType[] {
	if (stdin) return types.filter((t) => t === 'text' || t === 'file');
	const what = probe(value);
	if (what === 'dir') return types.filter((t) => t === 'folder');
	if (what === 'file') return types.filter((t) => t === 'text' || t === 'file');
	if (isUrl(value)) {
		return types.filter((t) => t === 'link' || (t === 'pr' && parsePrSpec(value) !== null));
	}
	return types.filter((t) => t === 'pr' && parsePrSpec(value) !== null);
}

/** The gate's spec as prose: `text (text/markdown)`, `folder`, `text`. */
function gateSpec(check: ArtifactRequirementCheck): string {
	const type = check.type ?? 'any type';
	return check.content_type ? `${type} (${check.content_type})` : type;
}

/** `"A"` / `"A" and "B"` / `"A", "B" and "C"`. */
function joinTransitions(names: string[]): string {
	const unique = [...new Set(names)].map((n) => `"${n}"`);
	if (unique.length <= 1) return unique.join('');
	return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/** The `fix` the server sent, or one computed locally when an older server omitted it. */
function fixCommand(gate: GateEntry, ref: string): string {
	return gate.check.fix || requirementFix(gate.check, ref).command;
}

/** Does `gate` accept an artifact of `type` declaring `contentType`? */
function accepts(gate: GateEntry, type: ArtifactType, contentType: string | undefined): boolean {
	const check = gate.check;
	if (check.type !== undefined && check.type !== type) return false;
	if (check.content_type === undefined) return true;
	// An unknown effective content type (server default / sniff deferred) cannot
	// be refused offline: only a declared one is checked.
	if (contentType === undefined) return true;
	return contentType.startsWith(check.content_type);
}

/** What a plan will actually declare, for the acceptance check. */
function effectiveContentType(
	type: ArtifactType,
	source: AttachSource,
	explicit: string | undefined,
	sniff: (path: string) => string
): string | undefined {
	if (explicit !== undefined) return explicit;
	if (type === 'text') return 'text/markdown'; // the server's default for a text artifact
	if (source.kind === 'file-path') return sniff(source.path);
	if (source.kind === 'file-stdin') return 'application/octet-stream';
	return undefined;
}

/**
 * The whole decision: flags plus an optional positional source, read against
 * the gates on this issue's available transitions.
 *
 * Throws `CliError` for every refusal — the caller is inside the action
 * handler, whose top-level `reportError` prints `error: <message>` and exits 1
 * without having written anything.
 */
export function planAttach(input: AttachPlanInput, sniff: (path: string) => string): AttachPlan {
	const { ref, name, positional, flags, probe } = input;
	assertOneSource(flags, positional);
	// --ignore-gates means "make no use of requirement data": inference falls
	// back to shape, and neither pre-flight check runs.
	const gates = flags.ignoreGates ? [] : input.gates;

	const plan =
		positional !== undefined
			? planPositional(name, positional, gates, probe, flags)
			: planFlags(flags, probe);

	if (gates.length > 0) {
		checkExistingSlot(plan, gates, ref, name, flags, positional);
		checkAccepted(plan, gates, ref, name, flags, positional, sniff);
	}
	return plan;
}

function planPositional(
	name: string,
	raw: string,
	gates: GateEntry[],
	probe: Probe,
	flags: AttachFlags
): AttachPlan {
	const { value, stdin } = normalizePositional(raw);
	const types = declaredTypes(gates);
	let type: ArtifactType | undefined;
	if (types.length === 1) {
		type = types[0];
	} else if (types.length > 1) {
		const compatible = shapeCompatible(types, value, stdin, probe);
		if (compatible.length === 1) {
			type = compatible[0];
		} else {
			const specs = gates
				.filter((g) => g.check.type !== undefined)
				.map((g) => `as ${g.check.type} by "${g.transition}"`);
			throw new CliError(
				`"${name}" is gated ${specs.join(' and ')}; pass ${types.map(flagFor).join('/')} to choose`
			);
		}
	}

	const contentType = flags.contentType ?? gateContentType(gates, type);
	const withCt = (p: AttachPlan): AttachPlan => ({
		...p,
		...(contentType !== undefined ? { contentType } : {}),
		...(flags.filename !== undefined ? { filename: flags.filename } : {})
	});

	if (type === undefined) {
		// Ungated (or gates that declare no type): shape alone decides, and
		// text is never inferred — the document has to come from --text.
		if (stdin) {
			throw new CliError(
				`"${name}" is not gated on this issue, so "-" has no type to read stdin as — use --text - for a document, or --file <path>`
			);
		}
		const what = probe(value);
		if (what === 'dir') return withCt({ type: 'folder', source: { kind: 'folder', dir: value } });
		if (what === 'file')
			return withCt({ type: 'file', source: { kind: 'file-path', path: value } });
		const pr = parsePrSpec(value);
		if (pr) return withCt({ type: 'pr', source: { kind: 'pr', pr } });
		if (isUrl(value)) {
			return withCt({
				type: 'link',
				source: {
					kind: 'link',
					url: value,
					...(flags.title !== undefined ? { title: flags.title } : {})
				}
			});
		}
		throw new CliError(
			`no such file "${value}" — a positional source is a path, a URL or owner/repo#N; inline text goes in --text (text is only inferred under a text gate)`
		);
	}

	switch (type) {
		case 'text': {
			if (stdin) return withCt({ type: 'text', source: { kind: 'text-stdin' } });
			const what = probe(value);
			if (what === 'dir') {
				throw new CliError(`"${value}" is a directory; "${name}" is gated as text`);
			}
			if (what === 'missing') throw new CliError(`cannot read ${value}: no such file`);
			return withCt({ type: 'text', source: { kind: 'text-path', path: value } });
		}
		case 'file': {
			if (stdin) return withCt({ type: 'file', source: { kind: 'file-stdin' } });
			const what = probe(value);
			if (what === 'dir') {
				throw new CliError(`"${value}" is a directory; "${name}" is gated as file`);
			}
			if (what === 'missing') throw new CliError(`cannot read ${value}: no such file`);
			return withCt({ type: 'file', source: { kind: 'file-path', path: value } });
		}
		case 'folder': {
			if (probe(value) !== 'dir') {
				throw new CliError(`"${name}" is gated as folder, but "${value}" is not a directory`);
			}
			return withCt({ type: 'folder', source: { kind: 'folder', dir: value } });
		}
		case 'link': {
			if (!isUrl(value)) {
				throw new CliError(`"${name}" is gated as link, but "${value}" is not an http(s) URL`);
			}
			return withCt({
				type: 'link',
				source: {
					kind: 'link',
					url: value,
					...(flags.title !== undefined ? { title: flags.title } : {})
				}
			});
		}
		case 'pr': {
			const pr = parsePrSpec(value);
			if (!pr) {
				throw new CliError(
					`"${name}" is gated as pr, but "${value}" is not owner/repo#N or a GitHub PR URL`
				);
			}
			return withCt({ type: 'pr', source: { kind: 'pr', pr } });
		}
	}
}

/** The content type a text/file plan inherits from its gates, when they agree on a concrete one. */
function gateContentType(gates: GateEntry[], type: ArtifactType | undefined): string | undefined {
	if (type !== 'text' && type !== 'file') return undefined;
	const declared = [
		...new Set(
			gates
				.filter((g) => g.check.type === type)
				.map((g) => concreteContentType(g.check.content_type))
				.filter((ct): ct is string => ct !== undefined)
		)
	];
	return declared.length === 1 ? declared[0] : undefined;
}

/** The pre-243 flag semantics, with the path checks moved offline. */
function planFlags(flags: AttachFlags, probe: Probe): AttachPlan {
	const ct = flags.contentType;
	const filename = flags.filename;
	const modifiers = {
		...(ct !== undefined ? { contentType: ct } : {}),
		...(filename !== undefined ? { filename } : {})
	};
	if (flags.folder !== undefined) {
		if (probe(flags.folder) !== 'dir') {
			throw new CliError(`--folder needs a directory, got "${flags.folder}"`);
		}
		return { type: 'folder', source: { kind: 'folder', dir: flags.folder }, ...modifiers };
	}
	if (flags.file !== undefined) {
		const what = probe(flags.file);
		if (what === 'missing') throw new CliError(`cannot read ${flags.file}: no such file`);
		if (what === 'dir')
			throw new CliError(`--file needs a file, got the directory "${flags.file}"`);
		return { type: 'file', source: { kind: 'file-path', path: flags.file }, ...modifiers };
	}
	if (flags.text !== undefined) {
		const v = flags.text;
		const source: AttachSource =
			v === '-' || v === '@-'
				? { kind: 'text-stdin' }
				: v.startsWith('@@')
					? { kind: 'text-inline', value: v.slice(1) }
					: v.startsWith('@')
						? { kind: 'text-path', path: v.slice(1) }
						: { kind: 'text-inline', value: v };
		return { type: 'text', source, ...modifiers };
	}
	if (flags.link !== undefined) {
		return {
			type: 'link',
			source: {
				kind: 'link',
				url: flags.link,
				...(flags.title !== undefined ? { title: flags.title } : {})
			},
			...modifiers
		};
	}
	const parsed = parsePrSpec(flags.pr!);
	if (!parsed) throw new CliError(`--pr takes owner/repo#N or a GitHub PR URL, got "${flags.pr}"`);
	return { type: 'pr', source: { kind: 'pr', pr: parsed }, ...modifiers };
}

/**
 * The slot already holds an artifact whose type is immutable. Saying so here
 * saves an upload the server would 422, and names the gate that cares.
 */
function checkExistingSlot(
	plan: AttachPlan,
	gates: GateEntry[],
	ref: string,
	name: string,
	flags: AttachFlags,
	positional: string | undefined
): void {
	const held = gates.find((g) => g.check.current_type !== null)?.check.current_type;
	if (held === undefined || held === null || held === plan.type) return;
	const rejecting = gates.find((g) => g.check.type !== undefined && g.check.type !== held);
	const fix = rejecting
		? fixCommand(rejecting, ref)
		: `tines issues artifacts delete ${ref} ${name} && tines issues artifacts attach ${ref} ${name} ${flagFor(plan.type)} <source>`;
	throw new CliError(
		`"${name}" already holds a ${held} artifact and the type is immutable; ${sourceLabel(flags, positional)} would attach ${plan.type}. Use: ${fix} (or --ignore-gates to attach it anyway)`
	);
}

/**
 * No available transition's requirement for this slot can ever accept what the
 * plan would create. Refuse rather than warn (PRD risk 2), and only when *no*
 * gate accepts — one satisfied gate is enough.
 */
function checkAccepted(
	plan: AttachPlan,
	gates: GateEntry[],
	ref: string,
	name: string,
	flags: AttachFlags,
	positional: string | undefined,
	sniff: (path: string) => string
): void {
	const effective = effectiveContentType(plan.type, plan.source, plan.contentType, sniff);
	if (gates.some((g) => accepts(g, plan.type, effective))) return;
	const label = sourceLabel(flags, positional);
	const typeMatched = gates.filter((g) => (g.check.type ?? plan.type) === plan.type);
	if (typeMatched.length > 0) {
		// The type is right and only the content type misses: the fix is a MIME,
		// not a different flag.
		const g = typeMatched[0];
		throw new CliError(
			`"${name}" is gated by ${joinTransitions(typeMatched.map((x) => x.transition))} as ${gateSpec(g.check)}; ${label} would attach ${effective ?? plan.type}, which does not satisfy it. Use: ${fixCommand(g, ref)} with --content-type <mime under ${g.check.content_type}> (or --ignore-gates to attach it anyway)`
		);
	}
	const g = gates[0];
	throw new CliError(
		`"${name}" is gated by ${joinTransitions(gates.map((x) => x.transition))} as ${gateSpec(g.check)}; ${label} would create a ${plan.type} artifact that can never satisfy it. Use: ${fixCommand(g, ref)} (or --ignore-gates to attach a ${plan.type} anyway)`
	);
}

/**
 * Which gates the artifact just written clears, and which still reject it —
 * the "satisfies"/"does not satisfy" half of the success line. Freshness is
 * implied: the version was written a moment ago.
 */
export function satisfiedBy(
	artifact: Pick<Artifact, 'name' | 'artifact_type' | 'current_version'>,
	gates: GateEntry[]
): { satisfies: string[]; rejects: { transition: string; wants: string }[] } {
	const satisfies: string[] = [];
	const rejects: { transition: string; wants: string }[] = [];
	for (const gate of gates) {
		if (gate.check.artifact !== artifact.name) continue;
		if (accepts(gate, artifact.artifact_type, artifact.current_version.content_type ?? undefined)) {
			satisfies.push(gate.transition);
		} else {
			rejects.push({ transition: gate.transition, wants: wantsLabel(gate, artifact) });
		}
	}
	return { satisfies, rejects };
}

function wantsLabel(gate: GateEntry, artifact: Pick<Artifact, 'artifact_type'>): string {
	const check = gate.check;
	if (check.type !== undefined && check.type !== artifact.artifact_type)
		return `wants ${check.type}`;
	return `wants ${check.content_type ?? check.type ?? 'something else'}`;
}

/** `artifacts list`'s GATE cell: what rejects this row, or '' when nothing does. */
export function gateLabel(
	artifact: Pick<Artifact, 'name' | 'artifact_type' | 'current_version'>,
	gates: GateEntry[]
): string {
	const { rejects } = satisfiedBy(artifact, gates);
	return [...new Set(rejects.map((r) => r.wants))].join('; ');
}

/** The `--help` epilogue: the typing rules, written where the reader is choosing a source. */
export const ATTACH_SOURCE_HELP = `
Source:
  A positional <source> is typed by the slot's gate when this issue has one:
  a text gate reads the path as the document (the gate's content type wins over
  the extension), a file gate uploads its bytes, a folder gate walks it, and a
  link/pr gate takes a URL or owner/repo#N. "-" reads stdin under a text or
  file gate.

  With no gate, the shape alone decides: a directory is a folder, an http(s)
  URL is a link (a GitHub PR URL is a pr), owner/repo#N is a pr, and anything
  else is a file — a .md path included. Inline text is never inferred: pass it
  with --text.

  Flags still override, and are refused before any network write when no
  available transition's requirement for the slot could ever accept what they
  would create. --ignore-gates attaches it anyway. Prefix a source starting
  with "-" with "--".`;
