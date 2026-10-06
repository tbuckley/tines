/** Read models for the Packs page, the pack page and the CLI. */
import {
	compilePackRecurrence,
	describeRecurrence,
	type PackDetail,
	type PackInputDecl,
	type PackInputValue,
	type PackInputView,
	type PackMissingInput,
	type PackRecurrence,
	type PackScheduleView,
	type PackSummary
} from '@tines/shared';
import { packDigest, writePackFiles } from '@tines/shared/packs';
import type { Kysely } from 'kysely';
import type { Database, PackRow } from '$lib/server/db';
import { listContextItems } from '../context';
import type { ActorContext } from '../core';
import { parseInputDecls } from '../pack-render';
import { packModelFromDb } from './model';

interface ValueRow {
	pack_id: string;
	name: string;
	text_value: string | null;
	repo_url: string | null;
	repo_branch: string | null;
	workflow_id: string | null;
	state_id: string | null;
}

function json<T>(raw: string | null | undefined, fallback: T): T {
	if (!raw) return fallback;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

/**
 * Each input with its value and whether it is missing. `workflows` maps
 * workflow ids that still exist to their names and states; `packKeys`
 * resolves a workflow input's default (a key in this pack).
 */
export function inputViews(
	decls: Record<string, PackInputDecl>,
	values: ValueRow[],
	workflows: Map<
		string,
		{ name: string; key: string | null; pack_id: string | null; states: Map<string, string> }
	>,
	mySecrets: Set<string>,
	packId: string
): PackInputView[] {
	return Object.entries(decls).map(([name, decl]) => {
		const row = values.find((v) => v.name === name);
		let value: PackInputValue | null = null;
		let missing = false;
		switch (decl.type) {
			case 'text':
				if (row?.text_value !== null && row?.text_value !== undefined)
					value = { type: 'text', text: row.text_value };
				missing = !value && decl.default === undefined && decl.required !== false;
				break;
			case 'repo':
				if (row?.repo_url)
					value = { type: 'repo', repo_url: row.repo_url, repo_branch: row.repo_branch };
				missing = !value;
				break;
			case 'workflow': {
				if (row) {
					const wf = row.workflow_id ? workflows.get(row.workflow_id) : undefined;
					value = {
						type: 'workflow',
						workflow_id: row.workflow_id,
						state_id: row.state_id,
						workflow_name: wf?.name ?? null,
						state_name: wf && row.state_id ? (wf.states.get(row.state_id) ?? null) : null
					};
					missing = !wf;
				} else {
					const key = decl.default?.split('/')[0];
					missing =
						!key || ![...workflows.values()].some((w) => w.pack_id === packId && w.key === key);
				}
				break;
			}
			case 'secret':
				missing = !mySecrets.has(name);
				return { name, decl, value: null, my_secret_set: mySecrets.has(name), missing };
		}
		return { name, decl, value, missing };
	});
}

export function missingOf(
	pack: { id: string; name: string },
	views: PackInputView[]
): PackMissingInput[] {
	return views
		.filter((v) => v.missing)
		.map((v) => ({
			pack_id: pack.id,
			pack_name: pack.name,
			input: v.name,
			type: v.decl.type,
			description: v.decl.description
		}));
}

/** The inputs of several packs at once, with values, bound workflows and the viewer's secrets. */
export async function loadInputViews(
	db: Kysely<Database>,
	packs: Pick<PackRow, 'id' | 'inputs'>[],
	viewerId: string
): Promise<Map<string, PackInputView[]>> {
	const ids = packs.map((p) => p.id).concat(['']);
	const [values, secrets] = await Promise.all([
		db.selectFrom('pack_input_value').selectAll().where('pack_id', 'in', ids).execute(),
		db
			.selectFrom('contributor_secret')
			.select(['pack_id', 'input_name'])
			.where('user_id', '=', viewerId)
			.where('pack_id', 'in', ids)
			.execute()
	]);
	const workflowIds = values.map((v) => v.workflow_id).filter((v): v is string => !!v);
	const wfRows = await db
		.selectFrom('workflow')
		.select(['id', 'name', 'key', 'pack_id'])
		.where((eb) => eb.or([eb('id', 'in', workflowIds.concat([''])), eb('pack_id', 'in', ids)]))
		.execute();
	const stRows = await db
		.selectFrom('workflow_state')
		.select(['id', 'name', 'workflow_id'])
		.where('workflow_id', 'in', wfRows.map((w) => w.id).concat(['']))
		.execute();
	const workflows = new Map(
		wfRows.map((w) => [
			w.id,
			{
				name: w.name,
				key: w.key,
				pack_id: w.pack_id,
				states: new Map(stRows.filter((s) => s.workflow_id === w.id).map((s) => [s.id, s.name]))
			}
		])
	);
	const out = new Map<string, PackInputView[]>();
	for (const pack of packs)
		out.set(
			pack.id,
			inputViews(
				parseInputDecls(pack.inputs),
				values.filter((v) => v.pack_id === pack.id),
				workflows,
				new Set(secrets.filter((s) => s.pack_id === pack.id).map((s) => s.input_name ?? '')),
				pack.id
			)
		);
	return out;
}

/** The digest an authored pack's current content would export with, at its last version. */
export async function authoredDigest(db: Kysely<Database>, pack: PackRow): Promise<string> {
	return packDigest(writePackFiles(await packModelFromDb(db, pack)));
}

export async function summarize(
	db: Kysely<Database>,
	packs: PackRow[],
	viewerId: string
): Promise<PackSummary[]> {
	if (packs.length === 0) return [];
	const ids = packs.map((p) => p.id);
	const sourceIds = packs.map((p) => p.source_pack_id).filter((v): v is string => !!v);
	const [inputs, counts, sources] = await Promise.all([
		loadInputViews(db, packs, viewerId),
		Promise.all([
			db
				.selectFrom('workflow')
				.select(['pack_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('pack_id', 'in', ids)
				.groupBy('pack_id')
				.execute(),
			db
				.selectFrom('context_item')
				.select(['pack_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('pack_id', 'in', ids)
				.groupBy('pack_id')
				.execute(),
			db
				.selectFrom('pack_schedule')
				.select(['pack_id', (eb) => eb.fn.countAll<number>().as('n')])
				.where('pack_id', 'in', ids)
				.groupBy('pack_id')
				.execute()
		]),
		db
			.selectFrom('pack')
			.leftJoin('project', 'project.id', 'pack.project_id')
			.selectAll('pack')
			.select('project.name as project_name')
			.where('pack.id', 'in', sourceIds.concat(['']))
			.execute()
	]);
	const count = (rows: { pack_id?: string | null; n: number }[], id: string) =>
		Number(rows.find((r) => r.pack_id === id)?.n ?? 0);
	const out: PackSummary[] = [];
	for (const pack of packs) {
		const source = sources.find((s) => s.id === pack.source_pack_id);
		let newer = false;
		if (pack.kind === 'installed' && source) {
			// Decided 2026-10-04: computed when the Packs page loads, by digest.
			const sourceDigest =
				source.kind === 'installed' ? source.digest : await authoredDigest(db, source);
			newer = sourceDigest !== pack.digest;
		}
		const changed =
			pack.kind === 'authored' &&
			(pack.version === null || (await authoredDigest(db, pack)) !== pack.digest);
		out.push({
			id: pack.id,
			pack_key: pack.pack_key,
			name: pack.name,
			description: pack.description,
			kind: pack.kind,
			version: pack.version,
			digest: pack.digest,
			position: pack.position,
			project_id: pack.project_id,
			source: pack.source_kind
				? {
						kind: pack.source_kind,
						pack_id: source ? source.id : null,
						project_id: source?.project_id ?? null,
						project_name: source?.project_name ?? null
					}
				: null,
			derived_from: json(pack.derived_from, null),
			needs_setup: missingOf(pack, inputs.get(pack.id) ?? []),
			newer_version_available: newer,
			changed_since_export: changed,
			workflow_count: count(counts[0], pack.id),
			item_count: count(counts[1], pack.id),
			schedule_count: count(counts[2], pack.id),
			revision: pack.revision,
			created_at: pack.created_at,
			updated_at: pack.updated_at
		});
	}
	return out;
}

export async function listProjectPacks(
	db: Kysely<Database>,
	projectId: string,
	viewerId: string
): Promise<PackSummary[]> {
	const packs = await db
		.selectFrom('pack')
		.selectAll()
		.where('project_id', '=', projectId)
		.orderBy('position')
		.execute();
	return summarize(db, packs, viewerId);
}

export function recurrenceText(r: PackRecurrence): string {
	try {
		const compiled = compilePackRecurrence(r);
		return 'preset' in compiled
			? describeRecurrence(compiled.preset, '')
			: describeRecurrence(null, compiled.cron);
	} catch {
		return 'cron' in r ? r.cron : String(r.every);
	}
}

export async function packDetail(
	db: Kysely<Database>,
	actor: ActorContext,
	pack: PackRow,
	viewerId: string
): Promise<PackDetail> {
	const [[summary], inputs, workflows, schedules, created, additions] = await Promise.all([
		summarize(db, [pack], viewerId),
		loadInputViews(db, [pack], viewerId),
		db
			.selectFrom('workflow')
			.select(['id', 'key', 'name', 'created_at'])
			.select((eb) =>
				eb
					.selectFrom('issue')
					.whereRef('issue.workflow_id', '=', 'workflow.id')
					.select((eb2) => eb2.fn.countAll<number>().as('n'))
					.as('issue_count')
			)
			.where('pack_id', '=', pack.id)
			.orderBy('created_at')
			.orderBy('id')
			.execute(),
		db
			.selectFrom('pack_schedule')
			.selectAll()
			.where('pack_id', '=', pack.id)
			.orderBy('position')
			.execute(),
		db
			.selectFrom('scheduled_task')
			.innerJoin('pack_schedule', 'pack_schedule.id', 'scheduled_task.pack_schedule_id')
			.select(['scheduled_task.id', 'scheduled_task.name', 'pack_schedule.schedule_key'])
			.where('pack_schedule.pack_id', '=', pack.id)
			.execute(),
		db
			.selectFrom('context_item')
			.innerJoin('workflow_state', 'workflow_state.id', 'context_item.workflow_state_id')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.select((eb) => eb.fn.countAll<number>().as('n'))
			.where('workflow.pack_id', '=', pack.id)
			.where('context_item.pack_id', 'is', null)
			.executeTakeFirst()
	]);
	const states = await db
		.selectFrom('workflow_state')
		.select(['id', 'key', 'name', 'category', 'run_scope', 'workflow_id', 'position'])
		.where('workflow_id', 'in', workflows.map((w) => w.id).concat(['']))
		.orderBy('position')
		.execute();
	const items = await packItems(db, actor, pack);
	return {
		...summary,
		readme: pack.readme,
		changelog: pack.changelog,
		inputs: inputs.get(pack.id) ?? [],
		workflows: workflows.map((w) => ({
			id: w.id,
			key: w.key ?? w.id,
			name: w.name,
			issue_count: Number(w.issue_count ?? 0),
			states: states
				.filter((s) => s.workflow_id === w.id)
				.map((s) => ({
					id: s.id,
					key: s.key ?? s.id,
					name: s.name,
					category: s.category,
					run_scope: s.run_scope
				}))
		})),
		items,
		schedules: schedules.map((s): PackScheduleView => {
			const recurrence = json<PackRecurrence>(s.recurrence, { cron: '' });
			return {
				key: s.schedule_key,
				name: s.name,
				workflow_key: s.workflow_key,
				start_key: s.start_key,
				recurrence,
				recurrence_text: recurrenceText(recurrence),
				only_when_previous_closed: s.only_when_previous_closed === 1,
				title: s.title,
				description: s.description,
				created_schedules: created
					.filter((c) => c.schedule_key === s.schedule_key)
					.map((c) => ({ id: c.id, name: c.name }))
			};
		}),
		project_addition_count: Number(additions?.n ?? 0)
	};
}

/** A pack's items through the ordinary context read (so disclosure rules apply), raw templates. */
async function packItems(db: Kysely<Database>, actor: ActorContext, pack: PackRow) {
	const out = [];
	let cursor: { createdAt: number; id: string } | null = null;
	for (let i = 0; i < 20; i++) {
		const page = await listContextItems(
			db,
			actor,
			{ project: pack.project_id ?? undefined, pack: pack.id },
			{ cursor, limit: 100 }
		);
		out.push(...page.items);
		if (!page.hasMore || page.items.length === 0) break;
		const last = page.items[page.items.length - 1];
		cursor = { createdAt: last.updated_at, id: last.id };
	}
	return out;
}

/**
 * Choices for a workflow input in this project: each usable workflow, and
 * each of its states, as `<workflow id>[|<state id>]`. Pack workflows of other
 * projects are left out.
 */
export async function workflowInputOptions(
	db: Kysely<Database>,
	ownerId: string,
	projectId: string
): Promise<{ value: string; label: string }[]> {
	const rows = await db
		.selectFrom('workflow')
		.leftJoin('pack', 'pack.id', 'workflow.pack_id')
		.select(['workflow.id', 'workflow.name', 'workflow.initial_state_id', 'pack.name as pack_name'])
		.where((eb) =>
			eb.or([eb('workflow.user_id', '=', ownerId), eb('workflow.user_id', 'is', null)])
		)
		.where((eb) =>
			eb.or([eb('workflow.pack_id', 'is', null), eb('pack.project_id', '=', projectId)])
		)
		.orderBy('workflow.name')
		.execute();
	const states = await db
		.selectFrom('workflow_state')
		.select(['id', 'name', 'workflow_id'])
		.where('workflow_id', 'in', rows.map((r) => r.id).concat(['']))
		.orderBy('position')
		.execute();
	return rows.flatMap((w) => {
		const name = w.pack_name ? `${w.name} · ${w.pack_name}` : w.name;
		return [
			{ value: w.id, label: name },
			...states
				.filter((s) => s.workflow_id === w.id && s.id !== w.initial_state_id)
				.map((s) => ({ value: `${w.id}|${s.id}`, label: `${name}, starting in ${s.name}` }))
		];
	});
}
