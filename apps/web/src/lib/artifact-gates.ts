/**
 * What the Attach dialog knows about the slot being filled: the requirement
 * on an available transition is the single source for the type it pre-selects,
 * the content type it declares, and the warning it shows when the operator
 * picks something the gate can never accept.
 *
 * The predicates themselves live in `@tines/shared` (`requirementAccepts`,
 * `declaredContentType`) — the same ones the CLI refuses on offline, so the
 * dialog and `tines issues artifacts attach` cannot disagree about what a gate
 * takes. What is web-only is the wording and the pre-selection order.
 */

import type { AllowedTransition, ArtifactRequirementCheck, ArtifactType } from '@tines/shared';
import { declaredContentType, requirementAccepts } from '@tines/shared';

/** One requirement on one available transition, keeping the transition's name for the note. */
export interface ArtifactGate {
	transition: string;
	check: ArtifactRequirementCheck;
}

/** Every requirement for `name` on an available transition, in transition order. */
export function gatesForName(
	allowedTransitions: AllowedTransition[],
	name: string
): ArtifactGate[] {
	const gates: ArtifactGate[] = [];
	for (const t of allowedTransitions) {
		for (const check of t.requires ?? []) {
			if (check.artifact === name) gates.push({ transition: t.name, check });
		}
	}
	return gates;
}

/** `text, text/markdown` / `folder` — the gate's spec as the dialog writes it. */
export function gateSpec(check: ArtifactRequirementCheck): string {
	const type = check.type ?? 'any type';
	return check.content_type ? `${type}, ${check.content_type}` : type;
}

/** The pre-selection the typed name earns from its gates. */
export interface AttachGateHint {
	/** The type to select: the first gate that declares one, in transition order. */
	type: ArtifactType;
	/** The transition that type came from. */
	transition: string;
	/** `text, text/markdown` for that transition. */
	spec: string;
	/** The other typed gates on the same slot, for the note's tail. */
	others: { transition: string; spec: string }[];
	/**
	 * The concrete MIME to declare with the write, when the typed gates agree on
	 * one. A prefix (`image/`) declares nothing — the server sniffs it, as the
	 * CLI leaves it to.
	 */
	contentType: string | undefined;
}

/**
 * Which requirement applies: the first gate declaring a type wins the
 * selector, the rest are listed. No gate declares a type → no pre-selection
 * (an untyped requirement constrains nothing).
 */
export function attachGateHint(gates: ArtifactGate[]): AttachGateHint | null {
	const typed = gates.filter((g) => g.check.type !== undefined);
	if (typed.length === 0) return null;
	const [first, ...rest] = typed;
	const type = first.check.type!;
	return {
		type,
		transition: first.transition,
		spec: gateSpec(first.check),
		others: rest.map((g) => ({ transition: g.transition, spec: gateSpec(g.check) })),
		contentType: declaredContentType(
			typed.map((g) => g.check),
			type
		)
	};
}

/** The chosen type cannot satisfy any gate on the slot. */
export interface AttachGateWarning {
	/** The first rejecting transition, and what it wants (`text`, `text/markdown`). */
	transition: string;
	wants: string;
	/** The other rejecting transitions, listed after it. */
	others: string[];
}

/**
 * Warn, never block: one satisfiable gate is enough, and an operator attaching
 * for a purpose no transition gates is doing nothing wrong. Mirrors the CLI's
 * `checkAccepted`/`checkExistingSlot`, minus the refusal.
 */
export function attachGateWarning(
	gates: ArtifactGate[],
	type: ArtifactType,
	contentType: string | undefined
): AttachGateWarning | null {
	if (gates.length === 0) return null;
	if (gates.some((g) => requirementAccepts(g.check, type, contentType))) return null;
	const rejecting = gates.filter((g) => !requirementAccepts(g.check, type, contentType));
	const [first, ...rest] = rejecting;
	return {
		transition: first.transition,
		wants: wantsLabel(first.check, type),
		others: [...new Set(rest.map((g) => g.transition))]
	};
}

/** What the gate is missing: the type when that is wrong, else the content type. */
function wantsLabel(check: ArtifactRequirementCheck, type: ArtifactType): string {
	if (check.type !== undefined && check.type !== type) return check.type;
	return check.content_type ?? check.type ?? 'something else';
}

/**
 * The content type a submit will declare, for the acceptance check and the
 * `PUT` body. A text write defaults to `text/markdown` (the server's default),
 * a file to the picked file's own type; folder/link/pr declare none.
 */
export function effectiveContentType(
	type: ArtifactType,
	gateContentType: string | undefined,
	fileType: string | undefined
): string | undefined {
	if (gateContentType !== undefined) return gateContentType;
	if (type === 'text') return 'text/markdown';
	if (type === 'file') return fileType || undefined;
	return undefined;
}
