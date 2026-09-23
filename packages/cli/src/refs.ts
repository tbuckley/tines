/**
 * Parsers for the references and body values an agent types on the command
 * line. Pure apart from the file reads, and they throw `CliError` rather than
 * exiting, so they can be tested directly.
 */
import { readFileSync } from 'node:fs';
import { type ContextFile, type ModelTier, MODEL_TIERS } from '@tines/shared';
import { CliError } from './errors.js';

export function parseJsonObject(raw: string, source: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (err) {
		throw new CliError(
			`invalid JSON from ${source}: ${err instanceof Error ? err.message : String(err)}`
		);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new CliError(`expected a JSON object from ${source}`);
	}
	return value as Record<string, unknown>;
}

/**
 * The creation nudge for workflow states: every NEW state (no "id") should
 * carry a "prompt" key — its initial stage instructions — unless the caller
 * declines with --no-prompts.
 */
export function assertNewStatesHavePrompts(states: unknown, prompts: boolean | undefined): void {
	if (prompts === false || !Array.isArray(states)) return;
	const missing = states
		.filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
		.filter((s) => s.id === undefined && !String(s.prompt ?? '').trim())
		.map((s) => (typeof s.name === 'string' ? s.name : '?'));
	if (missing.length > 0) {
		throw new CliError(
			`new state${missing.length === 1 ? '' : 's'} ${missing.map((n) => `"${n}"`).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no initial prompt — each state uses its exact context\n` +
				'  add "prompt": "<markdown>" to each new state in the JSON (its stage instructions), or pass --no-prompts to skip'
		);
	}
}

export function parseScheduleRef(ref: string): { project: string; name: string } {
	const sep = ref.indexOf('/');
	if (sep < 1 || sep === ref.length - 1) {
		throw new CliError(`schedule reference must look like <project>/<name>, got "${ref}"`);
	}
	return { project: ref.slice(0, sep), name: ref.slice(sep + 1) };
}

export function parseIssueRef(ref: string): { project: string; number: number } {
	const match = ref.match(/^(.+)\/(\d+)$/);
	if (!match) throw new CliError(`issue reference must look like <project>/<number>, got "${ref}"`);
	return { project: match[1], number: Number.parseInt(match[2], 10) };
}

/**
 * `--file <path>=@<local>`: maps a workspace path to a local file's content.
 * Workspace paths cannot contain `=`, so the first `=` is the separator;
 * content always comes from a file (no inline form).
 */
export function parseFileSpec(spec: string): ContextFile {
	const sep = spec.indexOf('=');
	if (sep < 1 || sep === spec.length - 1) {
		throw new CliError(`--file must look like <path>=@<local-file>, got "${spec}"`);
	}
	const path = spec.slice(0, sep);
	const source = spec.slice(sep + 1);
	if (!source.startsWith('@')) {
		throw new CliError(
			`skill file content always comes from a local file: --file ${path}=@<local-file>`
		);
	}
	const file = source.slice(1);
	try {
		return { path, content: readFileSync(file, 'utf8') };
	} catch (err) {
		throw new CliError(`cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** `<runner>[:tier]` — the last ":" separates an optional tier. */
export function parseTargetSpec(spec: string): { name: string; tier?: ModelTier } {
	const sep = spec.lastIndexOf(':');
	if (sep === -1) return { name: spec };
	const name = spec.slice(0, sep);
	const tier = spec.slice(sep + 1);
	if (!name) throw new CliError(`target must look like <runner>[:tier], got "${spec}"`);
	if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
		throw new CliError(`unknown tier "${tier}" in "${spec}" (tiers: ${MODEL_TIERS.join(', ')})`);
	}
	return { name, tier: tier as ModelTier };
}
