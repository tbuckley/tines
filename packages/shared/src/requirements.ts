/**
 * The one place that turns an artifact requirement into the command that
 * satisfies it. Every hint that tells someone how to attach — the launch
 * prompt's `Requires:` lines, `allowed_transitions[].requires[].fix` on the
 * issue read, and the `fix` in a `transition_requirements_unmet` 422 — comes
 * from here, so they cannot drift from each other or from the gate.
 */

import type { ArtifactRequirement, ArtifactRequirementCheck, ArtifactType } from './types.js';

/** The requirement fields the fix depends on (`fix` itself excluded). */
export type RequirementFixInput = Omit<ArtifactRequirementCheck, 'fix'>;

/**
 * What shape the fix takes, for callers that need to describe it in prose
 * rather than run it (the 422 summary changes wording per kind).
 *
 * - `attach` — the slot is empty, or holds a version that a new version of
 *   the same type would replace.
 * - `reattach_or_reaffirm` — the content is fine but stale; a new version or
 *   a reaffirm both clear the gate.
 * - `delete_and_attach` — the slot holds the wrong *type*, which is
 *   immutable, so no new version can help.
 */
export type RequirementFixKind = 'attach' | 'reattach_or_reaffirm' | 'delete_and_attach';

export interface RequirementFix {
	kind: RequirementFixKind;
	/** A runnable `tines …` command line. */
	command: string;
}

/**
 * The payload flag for a slot of `type`, specialised by the gate's declared
 * content type where that names a concrete file (a `text/markdown` gate wants
 * `--text @<slot>.md`, not the generic placeholder).
 *
 * `--link`, never `--url`: `-u, --url` is the API base URL on every CLI
 * command, and an agent copying it here would attach a link to the API itself
 * (Tines/92).
 */
function attachFlag(type: ArtifactType, slot: string, contentType: string | undefined): string {
	switch (type) {
		case 'file':
			return '--file <path>';
		case 'folder':
			return '--folder <dir>';
		case 'link':
			return '--link <url>';
		case 'pr':
			return '--pr <owner/repo#N>';
		case 'text': {
			const ext =
				contentType === 'text/markdown' ? 'md' : contentType === 'text/plain' ? 'txt' : null;
			return ext ? `--text @${slot}.${ext}` : '--text <markdown|@file>';
		}
	}
}

/**
 * The command that clears `r` on the issue `ref` ("Project/42"), with the
 * shape it takes. Pure: same requirement check in, same command out, on the
 * server and (once the CLI adopts it) in the CLI.
 *
 * A satisfied requirement still gets a command — the one that attaches a new
 * version of what is already there — so every entry on the wire carries one.
 */
export function requirementFix(r: RequirementFixInput, ref: string): RequirementFix {
	const attach = (type: ArtifactType): string =>
		`tines issues artifacts attach ${ref} ${r.artifact} ${attachFlag(type, r.artifact, r.content_type)}`;

	if (r.status === 'missing' || r.current_type === null) {
		return { kind: 'attach', command: attach(r.type ?? 'file') };
	}
	if (r.status === 'satisfied') {
		return { kind: 'attach', command: attach(r.current_type) };
	}
	if (r.status === 'stale') {
		// The slot passed the type checks, so a new version keeps the
		// artifact's own type — the artifact type is immutable, and an
		// attach under the requirement's declared type would 422 whenever
		// the two differ (e.g. an untyped requirement over a text slot).
		return {
			kind: 'reattach_or_reaffirm',
			command: `${attach(r.current_type)} — or, if the current content still stands: tines issues artifacts reaffirm ${ref} ${r.artifact}`
		};
	}
	// type_mismatch: when the artifact's own type can still satisfy the
	// requirement (a content_type-only miss on a file/text slot), a new
	// version under the same name is enough; otherwise the slot holds the
	// wrong immutable type and must be deleted before re-attaching.
	const reattachable =
		r.type === undefined
			? r.current_type === 'file' || r.current_type === 'text'
			: r.current_type === r.type;
	return reattachable
		? { kind: 'attach', command: attach(r.current_type) }
		: {
				kind: 'delete_and_attach',
				command: `tines issues artifacts delete ${ref} ${r.artifact} && ${attach(r.type ?? 'file')}`
			};
}

/**
 * A gate's declared content type names a concrete MIME, rather than a prefix
 * like `image/` — only a concrete one can be *declared* on a write; a prefix
 * is left to the server's sniff.
 */
export function concreteContentType(ct: string | undefined): string | undefined {
	return ct !== undefined && ct.includes('/') && !ct.endsWith('/') ? ct : undefined;
}

/**
 * Does a requirement accept an artifact of `type` declaring `contentType`?
 * The one predicate behind every offline gate check — the CLI's pre-flight
 * refusals and the web Attach dialog's warning read the same rules.
 */
export function requirementAccepts(
	r: ArtifactRequirement,
	type: ArtifactType,
	contentType: string | undefined
): boolean {
	if (r.type !== undefined && r.type !== type) return false;
	if (r.content_type === undefined) return true;
	// An unknown effective content type (server default / sniff deferred) cannot
	// be refused offline: only a declared one is checked.
	if (contentType === undefined) return true;
	return contentType.startsWith(r.content_type);
}

/**
 * The content type a `text`/`file` write inherits from its gates, when they
 * agree on a single concrete one. Other types declare nothing (a folder's
 * content types are per file; link/pr have none).
 */
export function declaredContentType(
	reqs: ArtifactRequirement[],
	type: ArtifactType | undefined
): string | undefined {
	if (type !== 'text' && type !== 'file') return undefined;
	const declared = [
		...new Set(
			reqs
				.filter((r) => r.type === type)
				.map((r) => concreteContentType(r.content_type))
				.filter((ct): ct is string => ct !== undefined)
		)
	];
	return declared.length === 1 ? declared[0] : undefined;
}
