/**
 * Packs ↔ rows (docs/packs.md). A pack's workflows and context live in the
 * ordinary `workflow` and `context_item` tables, tagged with `pack_id`; this
 * module turns a parsed `PackModel` into the statements that write them, and
 * reads them back into a `PackModel` (to export an authored pack, or to diff
 * one on Replace).
 */
import {
	PACK_FORMAT,
	scanPlaceholders,
	type PackEnv,
	type PackFile,
	type PackInputDecl,
	type PackLocation,
	type PackMigrationEntry,
	type PackModel,
	type PackPrompt,
	type PackRecurrence,
	type PackRepo,
	type PackRunScope,
	type PackSchedule,
	type PackSkill,
	type PackWorkflow,
	type RunScope
} from '@tines/shared';
import type { CompiledQuery, Kysely } from 'kysely';
import { newId, type Database, type PackRow } from '$lib/server/db';
import { parseInputDecls } from '../pack-render';

/** The pack format says `organization`; until organizations ship it is stored as `workspace`. */
export function storedRunScope(scope: PackRunScope): RunScope {
	return scope === 'organization' ? ('workspace' as RunScope) : (scope as RunScope);
}

export function packRunScope(scope: string): PackRunScope {
	return scope === 'workspace' || scope === 'organization'
		? 'organization'
		: (scope as PackRunScope);
}

export function bytesToB64(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** UTF-8 text of a file, or null when it is not valid UTF-8. */
export function fileText(file: PackFile): string | null {
	try {
		return decoder.decode(file.bytes);
	} catch {
		return null;
	}
}

function json<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/** Ids of the rows a model is written into: existing ones survive a Replace. */
export interface PackIds {
	workflows: Map<string, string>;
	/** `<workflow key>/<state key>` → state id. */
	states: Map<string, string>;
}

export function stateRef(workflowKey: string, stateKey: string): string {
	return `${workflowKey}/${stateKey}`;
}

export interface ItemWriteContext {
	ownerId: string;
	projectId: string;
	packId: string;
	ids: PackIds;
	now: number;
}

/** Where a pack item lands in `context_item`. */
function placement(loc: PackLocation, ctx: ItemWriteContext) {
	return {
		reach: loc.reach,
		workflow_id: loc.reach === 'workflow' ? (ctx.ids.workflows.get(loc.workflow!) ?? null) : null,
		workflow_state_id:
			loc.reach === 'state'
				? (ctx.ids.states.get(stateRef(loc.workflow!, loc.state!)) ?? null)
				: null
	};
}

function refsOf(inputs: Record<string, PackInputDecl>, texts: string[], bound: string | null) {
	const refs = new Set<string>();
	for (const text of texts)
		for (const name of scanPlaceholders(text)) if (inputs[name]) refs.add(name);
	if (bound) refs.add(bound);
	return refs.size ? JSON.stringify([...refs]) : null;
}

/** The statements that write every context item of `model` into the pack. */
export function packItemInsertQueries(
	db: Kysely<Database>,
	model: PackModel,
	ctx: ItemWriteContext
): CompiledQuery[] {
	const inputs = model.manifest.inputs;
	const queries: CompiledQuery[] = [];
	const base = (loc: PackLocation, kind: string, name: string, description: string) => ({
		id: newId('ctx'),
		user_id: ctx.ownerId,
		kind,
		name,
		description,
		project_id: ctx.projectId,
		issue_id: null,
		label_id: null,
		pack_id: ctx.packId,
		...placement(loc, ctx),
		version: 1,
		created_at: ctx.now,
		updated_at: ctx.now
	});
	for (const p of model.prompts) {
		queries.push(
			db
				.insertInto('context_item')
				.values({
					...base(p, 'prompt', p.name, p.description),
					body: p.body,
					position: p.order,
					input_refs: refsOf(inputs, [p.body], null)
				})
				.compile()
		);
	}
	model.skills.forEach((s, i) => {
		const row = base(s, 'skill', s.name, s.description);
		queries.push(
			db
				.insertInto('context_item')
				.values({
					...row,
					position: i,
					input_refs: refsOf(
						inputs,
						s.files.filter((f) => f.path.toLowerCase().endsWith('.md')).map((f) => f.content),
						null
					)
				})
				.compile()
		);
		for (const f of s.files)
			queries.push(
				db
					.insertInto('context_item_file')
					.values({
						id: newId('ctf'),
						context_item_id: row.id,
						path: f.path,
						content: f.content,
						created_at: ctx.now,
						updated_at: ctx.now
					})
					.compile()
			);
	});
	model.env.forEach((e, i) => {
		const input = 'input' in e.value ? e.value.input : null;
		const secret = input !== null && inputs[input]?.type === 'secret';
		queries.push(
			db
				.insertInto('context_item')
				.values({
					...base(e, 'env', e.name, ''),
					// A secret input's value is each contributor's own (`contributor_secret`):
					// the item stores the empty marker so every reader treats it as secret.
					env_value: secret ? null : 'template' in e.value ? e.value.template : '',
					env_value_enc: secret ? '' : null,
					env_hint: input ? `pack input ${input}` : null,
					config: input ? JSON.stringify({ input }) : null,
					position: i,
					input_refs: refsOf(inputs, 'template' in e.value ? [e.value.template] : [], input)
				})
				.compile()
		);
	});
	model.repos.forEach((r, i) => {
		queries.push(
			db
				.insertInto('context_item')
				.values({
					...base(r, 'repo', r.name, ''),
					repo_url: r.input ? '' : r.url,
					repo_branch: r.input ? null : r.branch,
					repo_dir: r.dir,
					config: r.input ? JSON.stringify({ input: r.input }) : null,
					position: i,
					input_refs: r.input ? JSON.stringify([r.input]) : null
				})
				.compile()
		);
	});
	return queries;
}

/** Deletes every context item of a pack (not the project additions on its states). */
export function packItemDeleteQueries(db: Kysely<Database>, packId: string): CompiledQuery[] {
	return [
		db
			.deleteFrom('context_item_file')
			.where(
				'context_item_id',
				'in',
				db.selectFrom('context_item').select('id').where('pack_id', '=', packId)
			)
			.compile(),
		db.deleteFrom('context_item').where('pack_id', '=', packId).compile()
	];
}

export function packScheduleInsertQueries(
	db: Kysely<Database>,
	packId: string,
	schedules: PackSchedule[],
	existing: Map<string, string> = new Map()
): CompiledQuery[] {
	return schedules.map((s, i) =>
		db
			.insertInto('pack_schedule')
			.values({
				// Keep a suggestion's id across versions, so a schedule created from it still points at it.
				id: existing.get(s.key) ?? newId('psch'),
				pack_id: packId,
				schedule_key: s.key,
				name: s.name,
				workflow_key: s.workflow,
				start_key: s.start,
				recurrence: JSON.stringify(s.recurrence),
				only_when_previous_closed: s.only_when_previous_closed ? 1 : 0,
				title: s.title,
				description: s.description,
				position: i
			})
			.compile()
	);
}

export async function snapshotInsertQueries(
	db: Kysely<Database>,
	packId: string,
	files: PackFile[]
): Promise<CompiledQuery[]> {
	const out: CompiledQuery[] = [
		db.deleteFrom('pack_snapshot_file').where('pack_id', '=', packId).compile()
	];
	for (const f of files)
		out.push(
			db
				.insertInto('pack_snapshot_file')
				.values({
					pack_id: packId,
					path: f.path,
					content_b64: bytesToB64(f.bytes),
					sha256: await sha256HexBytes(f.bytes)
				})
				.compile()
		);
	return out;
}

export async function loadSnapshotFiles(db: Kysely<Database>, packId: string): Promise<PackFile[]> {
	const rows = await db
		.selectFrom('pack_snapshot_file')
		.select(['path', 'content_b64'])
		.where('pack_id', '=', packId)
		.orderBy('path')
		.execute();
	return rows.map((r) => ({ path: r.path, bytes: b64ToBytes(r.content_b64) }));
}

/** Reads a pack's rows back into a model: what an authored pack would export as. */
export async function packModelFromDb(db: Kysely<Database>, pack: PackRow): Promise<PackModel> {
	const [workflows, states, transitions, items, schedules] = await Promise.all([
		db
			.selectFrom('workflow')
			.select(['id', 'name', 'description', 'initial_state_id', 'key', 'created_at'])
			.where('pack_id', '=', pack.id)
			.orderBy('created_at')
			.orderBy('id')
			.execute(),
		db
			.selectFrom('workflow_state')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select([
				'workflow_state.id',
				'workflow_state.workflow_id',
				'workflow_state.name',
				'workflow_state.category',
				'workflow_state.position',
				'workflow_state.run_scope',
				'workflow_state.key'
			])
			.where('workflow.pack_id', '=', pack.id)
			.orderBy('workflow_state.position')
			.execute(),
		db
			.selectFrom('workflow_transition')
			.innerJoin('workflow', 'workflow.id', 'workflow_transition.workflow_id')
			.select([
				'workflow_transition.id',
				'workflow_transition.name',
				'workflow_transition.from_state_id',
				'workflow_transition.to_state_id',
				'workflow_transition.requirements'
			])
			.where('workflow.pack_id', '=', pack.id)
			.orderBy('workflow_transition.id')
			.execute(),
		db
			.selectFrom('context_item')
			.selectAll()
			.where('pack_id', '=', pack.id)
			.orderBy('name')
			.execute(),
		db
			.selectFrom('pack_schedule')
			.selectAll()
			.where('pack_id', '=', pack.id)
			.orderBy('position')
			.execute()
	]);
	const files = items.length
		? await db
				.selectFrom('context_item_file')
				.select(['context_item_id', 'path', 'content'])
				.where(
					'context_item_id',
					'in',
					items
						.filter((i) => i.kind === 'skill')
						.map((i) => i.id)
						.concat([''])
				)
				.orderBy('path')
				.execute()
		: [];
	const wfKey = new Map(workflows.map((w) => [w.id, w.key ?? w.id]));
	const stateById = new Map(states.map((s) => [s.id, s]));
	const location = (row: {
		reach?: string | null;
		workflow_id?: string | null;
		workflow_state_id: string | null;
	}): PackLocation => {
		const reach = (row.reach ?? 'project') as PackLocation['reach'];
		if (reach === 'workflow')
			return { reach, workflow: wfKey.get(row.workflow_id ?? '') ?? null, state: null };
		if (reach === 'state') {
			const s = stateById.get(row.workflow_state_id ?? '');
			return {
				reach,
				workflow: s ? (wfKey.get(s.workflow_id) ?? null) : null,
				state: s?.key ?? null
			};
		}
		return { reach, workflow: null, state: null };
	};
	const workflowModels: PackWorkflow[] = workflows.map((w) => {
		const own = states.filter((s) => s.workflow_id === w.id);
		return {
			key: w.key ?? w.id,
			name: w.name,
			description: w.description,
			initial: stateById.get(w.initial_state_id)?.key ?? own[0]?.key ?? '',
			states: own.map((s) => ({
				key: s.key ?? s.id,
				name: s.name,
				category: s.category,
				run_scope: packRunScope(s.run_scope),
				transitions: transitions
					.filter((t) => t.from_state_id === s.id)
					.map((t) => ({
						name: t.name,
						to: stateById.get(t.to_state_id)?.key ?? t.to_state_id,
						...(t.requirements ? { requires: JSON.parse(t.requirements) } : {})
					}))
			}))
		};
	});
	const prompts: PackPrompt[] = [];
	const skills: PackSkill[] = [];
	const env: PackEnv[] = [];
	const repos: PackRepo[] = [];
	for (const item of items) {
		const loc = location(item);
		const input = json<{ input?: string }>(item.config, {}).input ?? null;
		if (item.kind === 'prompt')
			prompts.push({
				...loc,
				name: item.name,
				description: item.description,
				order: item.position,
				body: item.body ?? ''
			});
		else if (item.kind === 'skill')
			skills.push({
				...loc,
				name: item.name,
				description: item.description,
				files: files
					.filter((f) => f.context_item_id === item.id)
					.map((f) => ({ path: f.path, content: f.content }))
			});
		else if (item.kind === 'env')
			env.push({
				...loc,
				name: item.name,
				value: input ? { input } : { template: item.env_value ?? '' }
			});
		else if (item.kind === 'repo')
			repos.push({
				...loc,
				name: item.name,
				input,
				url: input ? null : item.repo_url,
				branch: input ? null : item.repo_branch,
				dir: item.repo_dir
			});
	}
	return {
		manifest: {
			format: PACK_FORMAT,
			id: pack.pack_key,
			name: pack.name,
			version: pack.version,
			description: pack.description,
			derived_from: json(pack.derived_from, null),
			inputs: parseInputDecls(pack.inputs)
		},
		readme: pack.readme,
		changelog: pack.changelog,
		migrations: json<Record<string, PackMigrationEntry>>(pack.migrations, {}),
		workflows: workflowModels,
		prompts,
		skills,
		env,
		repos,
		schedules: schedules.map((s) => ({
			key: s.schedule_key,
			name: s.name,
			workflow: s.workflow_key,
			start: s.start_key,
			recurrence: json<PackRecurrence>(s.recurrence, { cron: '0 9 * * 1' }),
			only_when_previous_closed: s.only_when_previous_closed === 1,
			title: s.title,
			description: s.description
		}))
	};
}
