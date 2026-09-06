/**
 * The one place that turns an artifact requirement into the command that
 * satisfies it. Every hint that tells someone how to attach — the launch
 * prompt's `Requires:` lines, `allowed_transitions[].requires[].fix` on the
 * issue read, and the `fix` in a `transition_requirements_unmet` 422 — comes
 * from here, so they cannot drift from each other or from the gate.
 */

import type { ArtifactRequirementCheck, ArtifactType } from './types.js';

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
	/** A runnable `tines …` command line — one command, copy-pastable whole. */
	command: string;
	/**
	 * A second, equally runnable command that also clears the requirement, when
	 * one exists (`reattach_or_reaffirm`: the reaffirm). Kept out of `command`
	 * so a consumer can render each in its own code span — a single span
	 * carrying both fails with commander's `too many arguments` when copied
	 * (Tines/255).
	 */
	alternative?: string;
}

/**
 * The payload flag for a slot of `type`, specialised by the gate's declared
 * content type where that names a concrete file (a `text/markdown` gate wants
 * `--text @<slot>.md`, not the generic placeholder).
 *
 * Only *untyped* requirements render this now (see `attachArg`): with no
 * declared type the CLI has nothing to type a positional source by, and its
 * shape-only inference never guesses `text`.
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
 * The positional `<source>` for a slot of `type` under a gate that declares
 * it, named after what the reader has to supply: a concrete text gate wants a
 * file whose default name is the slot's (`<slot>.md`), everything else a
 * placeholder. The CLI types a positional source by the gate and declares the
 * gate's concrete content type with the upload (spec "Typing"), so
 * `attach <ref> prd prd.md` under a `(text, text/plain)` gate stores
 * `text/plain` — no `--content-type` tail needed (Tines/255).
 */
function positionalSource(
	type: ArtifactType,
	slot: string,
	contentType: string | undefined
): string {
	switch (type) {
		case 'file':
			return '<path>';
		case 'folder':
			return '<dir>';
		case 'link':
			return '<url>';
		case 'pr':
			return '<owner/repo#N>';
		case 'text': {
			const ext =
				contentType === 'text/markdown' ? 'md' : contentType === 'text/plain' ? 'txt' : null;
			return ext ? `${slot}.${ext}` : '<path>';
		}
	}
}

/**
 * The source argument the fix command carries: the one-line positional form
 * for a gate that declares a `type` (Tines/274 — safe since the gate-typed
 * positional shipped in `tines@0.0.141`; an older CLI fails it with
 * commander's `too many arguments`, having written nothing), and the flag
 * form for an untyped one, whose type only a flag can pin down.
 */
function attachArg(
	r: RequirementFixInput,
	type: ArtifactType,
	contentType: string | undefined
): string {
	return r.type === undefined
		? attachFlag(type, r.artifact, contentType)
		: positionalSource(type, r.artifact, contentType);
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
		`tines issues artifacts attach ${ref} ${r.artifact} ${attachArg(r, type, r.content_type)}`;

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
			command: attach(r.current_type),
			alternative: `tines issues artifacts reaffirm ${ref} ${r.artifact}`
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
