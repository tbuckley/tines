/**
 * Rendering pack text with the project's input values (specs/packs/MVP_SPEC.md,
 * "Placeholders"). Pack items store their text as templates; every surface
 * that shows or delivers effective context renders it here, at read time, so
 * a changed value takes effect at the next launch with nothing rewritten.
 *
 * The same decisions back `packInputsMissingPredicate`, the SQL form dispatch
 * uses to refuse a run whose context needs a value nobody supplied. Change one
 * and change the other.
 */
import {
	describeWorkflowInput,
	renderPlaceholders,
	type ContextFile,
	type PackInputDecl,
	type PackMissingInput
} from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import { decryptSecret } from '../crypto';

/** What a pack row needs to render: the columns `contextItemQuery` selects. */
export interface RenderableRow {
	id: string;
	kind: string;
	pack_id?: string | null;
	project_id: string | null;
	body: string | null;
	config: string | null;
	env_value: string | null;
	env_value_enc: string | null;
	env_hint: string | null;
	repo_url: string | null;
	repo_branch: string | null;
	input_refs?: string | null;
}

interface InputValueRow {
	name: string;
	text_value: string | null;
	repo_url: string | null;
	repo_branch: string | null;
	workflow_id: string | null;
	state_id: string | null;
}

export interface LoadedPack {
	id: string;
	name: string;
	projectName: string;
	inputs: Record<string, PackInputDecl>;
	values: Map<string, InputValueRow>;
	/** Workflow inputs: the bound (or defaulted) workflow, resolved. */
	workflows: Map<string, { id: string; name: string; stateName: string } | null>;
	/** Secret inputs the contributor has supplied. */
	secrets: Set<string>;
}

export interface PackRenderContext {
	packs: Map<string, LoadedPack>;
	/** The contributor whose secrets apply, if any (the run's, or the viewer's). */
	contributorId: string | null;
}

export function parseInputDecls(raw: string | null | undefined): Record<string, PackInputDecl> {
	try {
		const parsed: unknown = JSON.parse(raw ?? '{}');
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, PackInputDecl>) : {};
	} catch {
		return {};
	}
}

export function inputRefs(row: { input_refs?: string | null }): string[] {
	if (!row.input_refs) return [];
	try {
		const parsed: unknown = JSON.parse(row.input_refs);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
	} catch {
		return [];
	}
}

/** `config.input` of an env or repo item bound to an input. */
export function boundInput(row: { config: string | null }): string | null {
	if (!row.config) return null;
	try {
		const parsed = JSON.parse(row.config) as { input?: unknown };
		return typeof parsed.input === 'string' ? parsed.input : null;
	} catch {
		return null;
	}
}

/** Loads input declarations, values and bound workflows for every pack the rows come from. */
export async function loadPackRenderContext(
	db: Kysely<Database>,
	packIds: string[],
	contributorId: string | null
): Promise<PackRenderContext> {
	const ids = [...new Set(packIds)];
	const packs = new Map<string, LoadedPack>();
	if (ids.length === 0) return { packs, contributorId };
	const [packRows, valueRows, secretRows] = await Promise.all([
		db
			.selectFrom('pack')
			.leftJoin('project', 'project.id', 'pack.project_id')
			.select(['pack.id', 'pack.name', 'pack.inputs', 'project.name as project_name'])
			.where('pack.id', 'in', ids)
			.execute(),
		db
			.selectFrom('pack_input_value')
			.select([
				'pack_id',
				'name',
				'text_value',
				'repo_url',
				'repo_branch',
				'workflow_id',
				'state_id'
			])
			.where('pack_id', 'in', ids)
			.execute(),
		contributorId
			? db
					.selectFrom('contributor_secret')
					.select(['pack_id', 'input_name'])
					.where('user_id', '=', contributorId)
					.where('pack_id', 'in', ids)
					.execute()
			: Promise.resolve([] as { pack_id: string | null; input_name: string | null }[])
	]);
	for (const row of packRows) {
		packs.set(row.id, {
			id: row.id,
			name: row.name,
			projectName: row.project_name ?? '',
			inputs: parseInputDecls(row.inputs),
			values: new Map(valueRows.filter((v) => v.pack_id === row.id).map((v) => [v.name, v])),
			workflows: new Map(),
			secrets: new Set(
				secretRows.filter((s) => s.pack_id === row.id).map((s) => s.input_name ?? '')
			)
		});
	}
	// Resolve workflow inputs: an explicit binding, or the declared default
	// (a workflow of the pack itself, by key).
	const wanted: {
		pack: LoadedPack;
		name: string;
		workflowId: string | null;
		stateId: string | null;
		defaultRef: string | null;
	}[] = [];
	for (const pack of packs.values()) {
		for (const [name, decl] of Object.entries(pack.inputs)) {
			if (decl.type !== 'workflow') continue;
			const value = pack.values.get(name);
			wanted.push({
				pack,
				name,
				workflowId: value?.workflow_id ?? null,
				stateId: value?.state_id ?? null,
				defaultRef: value ? null : (decl.default ?? null)
			});
		}
	}
	if (wanted.length > 0) {
		const workflowRows = await db
			.selectFrom('workflow')
			.select(['id', 'name', 'initial_state_id', 'pack_id', 'key'])
			.where((eb) =>
				eb.or([
					eb(
						'id',
						'in',
						wanted
							.map((w) => w.workflowId ?? '')
							.filter(Boolean)
							.concat([''])
					),
					eb('pack_id', 'in', ids)
				])
			)
			.execute();
		const stateRows = await db
			.selectFrom('workflow_state')
			.select(['id', 'name', 'workflow_id', 'key'])
			.where('workflow_id', 'in', workflowRows.map((w) => w.id).concat(['']))
			.execute();
		for (const w of wanted) {
			let workflow = w.workflowId ? workflowRows.find((r) => r.id === w.workflowId) : undefined;
			let stateId = w.stateId;
			if (!w.workflowId && w.defaultRef) {
				const [wfKey, stateKey] = w.defaultRef.split('/');
				workflow = workflowRows.find((r) => r.pack_id === w.pack.id && r.key === wfKey);
				if (workflow && stateKey)
					stateId =
						stateRows.find((s) => s.workflow_id === workflow!.id && s.key === stateKey)?.id ?? null;
			}
			if (!workflow) {
				w.pack.workflows.set(w.name, null);
				continue;
			}
			const state =
				stateRows.find(
					(s) => s.id === (stateId ?? workflow!.initial_state_id) && s.workflow_id === workflow!.id
				) ?? stateRows.find((s) => s.id === workflow!.initial_state_id);
			w.pack.workflows.set(w.name, {
				id: workflow.id,
				name: workflow.name,
				stateName: state?.name ?? ''
			});
		}
	}
	return { packs, contributorId };
}

type Resolved = { ok: true; value: string } | { ok: false; missing: PackMissingInput };

function missingInput(pack: LoadedPack, name: string): PackMissingInput {
	return (missing(pack, name) as { ok: false; missing: PackMissingInput }).missing;
}

function missing(pack: LoadedPack, name: string): Resolved {
	const decl = pack.inputs[name];
	return {
		ok: false,
		missing: {
			pack_id: pack.id,
			pack_name: pack.name,
			input: name,
			type: decl?.type ?? 'text',
			description: decl?.description ?? ''
		}
	};
}

/** The text an input renders as, or why it cannot. Secrets never render here. */
export function resolveInputText(ctx: PackRenderContext, packId: string, name: string): Resolved {
	const pack = ctx.packs.get(packId);
	if (!pack) return { ok: true, value: '' };
	const decl = pack.inputs[name];
	if (!decl) return missing(pack, name);
	const value = pack.values.get(name);
	switch (decl.type) {
		case 'text':
			if (value?.text_value !== null && value?.text_value !== undefined)
				return { ok: true, value: value.text_value };
			if (decl.default !== undefined) return { ok: true, value: decl.default };
			if (decl.required === false) return { ok: true, value: '' };
			return missing(pack, name);
		case 'repo':
			return value?.repo_url ? { ok: true, value: value.repo_url } : missing(pack, name);
		case 'workflow': {
			const wf = pack.workflows.get(name);
			if (!wf) return missing(pack, name);
			return {
				ok: true,
				value: describeWorkflowInput({
					workflowName: wf.name,
					stateName: wf.stateName,
					workflowId: wf.id,
					projectName: pack.projectName
				})
			};
		}
		case 'secret':
			return pack.secrets.has(name) || !ctx.contributorId
				? { ok: true, value: '' }
				: missing(pack, name);
	}
}

/** Whether the contributor's secret for `name` is missing (always false with no contributor). */
function secretMissing(ctx: PackRenderContext, pack: LoadedPack, name: string): boolean {
	return ctx.contributorId !== null && !pack.secrets.has(name);
}

/**
 * Renders one pack row's text (prompt body, env template, bound repo) and
 * reports the values it lacks. Rows outside packs come back unchanged.
 */
export function renderPackRow<R extends RenderableRow>(
	row: R,
	ctx: PackRenderContext
): { row: R; missing: PackMissingInput[] } {
	if (!row.pack_id) return { row, missing: [] };
	const pack = ctx.packs.get(row.pack_id);
	if (!pack) return { row, missing: [] };
	const lacks: PackMissingInput[] = [];
	const resolve = (name: string) => {
		const r = resolveInputText(ctx, row.pack_id!, name);
		if (r.ok) return r.value;
		lacks.push(r.missing);
		return undefined;
	};
	const out = { ...row };
	if (row.kind === 'prompt' && row.body !== null) {
		out.body = renderPlaceholders(row.body, resolve).text;
	}
	if (row.kind === 'env') {
		const input = boundInput(row);
		if (input) {
			const decl = pack.inputs[input];
			if (decl?.type === 'secret') {
				out.env_hint = row.env_hint ?? `pack ${pack.name} · ${input}`;
				if (secretMissing(ctx, pack, input)) lacks.push(missingInput(pack, input));
			} else {
				out.env_value = resolve(input) ?? '';
			}
		} else if (row.env_value !== null) {
			out.env_value = renderPlaceholders(row.env_value, resolve).text;
		}
	}
	if (row.kind === 'repo') {
		const input = boundInput(row);
		if (input) {
			const value = pack.values.get(input);
			const decl = pack.inputs[input];
			if (value?.repo_url) {
				out.repo_url = value.repo_url;
				out.repo_branch =
					value.repo_branch ?? (decl?.type === 'repo' ? (decl.default_branch ?? null) : null);
			} else {
				lacks.push(missingInput(pack, input));
				out.repo_url = '';
			}
		}
	}
	return { row: out, missing: lacks };
}

/** Renders the `.md` files of a pack skill. Other files are delivered byte for byte. */
export function renderPackSkillFiles(
	packId: string,
	files: ContextFile[],
	ctx: PackRenderContext
): { files: ContextFile[]; missing: PackMissingInput[] } {
	const lacks: PackMissingInput[] = [];
	const resolve = (name: string) => {
		const r = resolveInputText(ctx, packId, name);
		if (r.ok) return r.value;
		lacks.push(r.missing);
		return undefined;
	};
	return {
		files: files.map((f) =>
			f.path.toLowerCase().endsWith('.md')
				? { ...f, content: renderPlaceholders(f.content, resolve).text }
				: f
		),
		missing: lacks
	};
}

/** Renders every pack row in `rows` (and the files of pack skills), collecting what is missing. */
export async function renderPackRows<R extends RenderableRow>(
	db: Kysely<Database>,
	rows: R[],
	fileMap: Map<string, ContextFile[]>,
	contributorId: string | null
): Promise<{ rows: R[]; fileMap: Map<string, ContextFile[]>; missing: PackMissingInput[] }> {
	const packIds = rows.map((r) => r.pack_id).filter((id): id is string => !!id);
	if (packIds.length === 0) return { rows, fileMap, missing: [] };
	const ctx = await loadPackRenderContext(db, packIds, contributorId);
	const lacks: PackMissingInput[] = [];
	const out = rows.map((row) => {
		const r = renderPackRow(row, ctx);
		lacks.push(...r.missing);
		return r.row;
	});
	const files = new Map(fileMap);
	for (const row of rows) {
		if (row.kind !== 'skill' || !row.pack_id || !fileMap.has(row.id)) continue;
		const r = renderPackSkillFiles(row.pack_id, fileMap.get(row.id)!, ctx);
		files.set(row.id, r.files);
		lacks.push(...r.missing);
	}
	return { rows: out, fileMap: files, missing: dedupeMissing(lacks) };
}

export function dedupeMissing(list: PackMissingInput[]): PackMissingInput[] {
	const seen = new Map<string, PackMissingInput>();
	for (const m of list) seen.set(`${m.pack_id}\0${m.input}`, m);
	return [...seen.values()];
}

/** The contributor's own secret value for a pack input, decrypted. */
export async function contributorSecretValue(
	db: Kysely<Database>,
	key: string,
	userId: string,
	packId: string,
	input: string
): Promise<string | null> {
	const row = await db
		.selectFrom('contributor_secret')
		.select('value_enc')
		.where('user_id', '=', userId)
		.where('pack_id', '=', packId)
		.where('input_name', '=', input)
		.executeTakeFirst();
	return row ? decryptSecret(row.value_enc, key) : null;
}

/**
 * True (in SQL) when an issue's context reads a pack input that has no value
 * for `contributorId`: dispatch never claims such an issue. Mirrors
 * `resolveInputText` over the same tables. Conservative on one point: a pack
 * item counts even if a later layer overrides it by name.
 *
 * Expects `issue` in scope as the candidate issue's alias.
 */
export function packInputsMissingPredicate(contributorId: string) {
	const decl = (field: string) =>
		sql`json_extract(p.inputs, '$.' || r.value || '.${sql.raw(field)}')`;
	return sql<boolean>`EXISTS (
		SELECT 1 FROM context_item ci
		JOIN pack p ON p.id = ci.pack_id
		JOIN json_each(COALESCE(ci.input_refs, '[]')) r
		WHERE ci.pack_id IS NOT NULL
			AND ci.project_id = issue.project_id
			AND (ci.reach = 'project'
				OR (ci.reach = 'pack' AND ci.pack_id = (SELECT w.pack_id FROM workflow w WHERE w.id = issue.workflow_id))
				OR (ci.reach = 'workflow' AND ci.workflow_id = issue.workflow_id)
				OR (ci.reach = 'state' AND ci.workflow_state_id = issue.state_id))
			AND (CASE ${decl('type')}
				WHEN 'secret' THEN NOT EXISTS (SELECT 1 FROM contributor_secret cs
					WHERE cs.user_id = ${contributorId} AND cs.pack_id = p.id AND cs.input_name = r.value)
				WHEN 'text' THEN NOT EXISTS (SELECT 1 FROM pack_input_value v
						WHERE v.pack_id = p.id AND v.name = r.value AND v.text_value IS NOT NULL)
					AND ${decl('default')} IS NULL
					AND COALESCE(${decl('required')}, 1) != 0
				WHEN 'repo' THEN NOT EXISTS (SELECT 1 FROM pack_input_value v
					WHERE v.pack_id = p.id AND v.name = r.value AND v.repo_url IS NOT NULL)
				WHEN 'workflow' THEN NOT EXISTS (SELECT 1 FROM pack_input_value v
						JOIN workflow w ON w.id = v.workflow_id
						WHERE v.pack_id = p.id AND v.name = r.value)
					AND (${decl('default')} IS NULL OR EXISTS (SELECT 1 FROM pack_input_value v
						WHERE v.pack_id = p.id AND v.name = r.value))
				ELSE 1 END)
	)`;
}
