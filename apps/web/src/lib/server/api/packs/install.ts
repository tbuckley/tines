/**
 * Install, Replace and Export (docs/packs.md). Install and Replace are two
 * steps: `prepare*` reviews an upload and returns its digest; the confirming
 * call re-sends the upload and is refused unless it has that same digest, so
 * what is applied is exactly what was reviewed. Each apply is one D1 batch.
 */
import {
	PACK_ARCHIVE_MAX_BYTES,
	type InstallPackRequest,
	type PackAdds,
	type PackExport,
	type PackFile,
	type PackFileChange,
	type PackMappingTarget,
	type PackModel,
	type PackParseResult,
	type PackReceipt,
	type PackReplacement,
	type PackReview,
	type PackStateMappingRow,
	type PackUpload,
	type ReplacePackRequest
} from '@tines/shared';
import {
	normalizePackFiles,
	packDigest,
	packFolderName,
	parsePack,
	readPackArchive,
	writePackFiles
} from '@tines/shared/packs';
import { sql, type CompiledQuery, type Kysely } from 'kysely';
import { newId, randomString, type Database, type PackRow } from '$lib/server/db';
import { ApiFail, notFound, runAtomic, type ActorContext } from '../core';
import { eventInsert } from '../events';
import { parseInputDecls } from '../pack-render';
import { actorForProject } from '../project-access';
import { accessAllowed } from '../permissions';
import { assertBrowser, loadPack, packProject, revisionConflict, type PackProject } from './access';
import {
	b64ToBytes,
	bytesToB64,
	fileText,
	loadSnapshotFiles,
	packItemDeleteQueries,
	packItemInsertQueries,
	packModelFromDb,
	packScheduleInsertQueries,
	snapshotInsertQueries,
	stateRef
} from './model';
import { renderContextFor, scheduleFromSuggestionQueries, takenScheduleNames } from './schedules';
import { inputViews, loadInputViews, summarize } from './views';
import {
	resolveValues,
	secretWriteQueries,
	valueWriteQueries,
	type PackWorkflowKeys
} from './values';
import {
	chainedRenames,
	loadExistingPackWorkflows,
	planPackWorkflows,
	type WorkflowWritePlan
} from './workflows';

// ---------------------------------------------------------------------------
// Uploads

/** Reads an upload (a zipped pack or its files) and validates it. */
export async function readUpload(body: unknown): Promise<PackParseResult> {
	const upload = (body ?? {}) as Partial<PackUpload>;
	if (typeof upload.archive_b64 === 'string') {
		if (upload.archive_b64.length > Math.ceil((PACK_ARCHIVE_MAX_BYTES * 4) / 3) + 4)
			throw new ApiFail(413, 'pack_too_large', 'A pack archive may be at most 5 MiB');
		let bytes: Uint8Array;
		try {
			bytes = b64ToBytes(upload.archive_b64);
		} catch {
			throw new ApiFail(422, 'invalid_field', '"archive_b64" is not valid base64', {
				field: 'archive_b64'
			});
		}
		const read = readPackArchive(bytes);
		if (read.errors.length)
			return {
				model: null,
				errors: read.errors,
				warnings: [],
				files: read.files,
				digest: read.files.length ? await packDigest(read.files) : ''
			};
		return parsePack(read.files);
	}
	if (Array.isArray(upload.files)) {
		let total = 0;
		const files: PackFile[] = upload.files.map((f, i) => {
			if (!f || typeof f.path !== 'string' || typeof f.content_b64 !== 'string')
				throw new ApiFail(422, 'invalid_field', `files[${i}] needs "path" and "content_b64"`, {
					field: 'files'
				});
			const bytes = b64ToBytes(f.content_b64);
			total += bytes.length;
			return { path: f.path, bytes };
		});
		if (total > PACK_ARCHIVE_MAX_BYTES)
			throw new ApiFail(413, 'pack_too_large', 'A pack may be at most 5 MiB');
		const normalized = normalizePackFiles(files);
		if (normalized.errors.length)
			return {
				model: null,
				errors: normalized.errors,
				warnings: [],
				files: normalized.files,
				digest: await packDigest(normalized.files)
			};
		return parsePack(normalized.files);
	}
	throw new ApiFail(422, 'invalid_field', 'Send the pack as "archive_b64" or "files"', {
		field: 'archive_b64'
	});
}

function invalidPack(parsed: PackParseResult): ApiFail {
	return new ApiFail(
		422,
		'invalid_pack',
		`The pack has ${parsed.errors.length} error(s); validate it first`,
		{
			errors: parsed.errors
		}
	);
}

function digestMismatch(): ApiFail {
	return new ApiFail(
		409,
		'pack_digest_mismatch',
		'The pack differs from the one you reviewed; review it again before confirming'
	);
}

// ---------------------------------------------------------------------------
// Review

export function packAdds(model: PackModel): PackAdds {
	const loc = (r: { reach: string; workflow: string | null; state: string | null }) =>
		r.reach === 'project'
			? 'project'
			: r.reach === 'pack'
				? 'pack'
				: r.state
					? `${r.workflow}/${r.state}`
					: (r.workflow ?? '');
	return {
		workflows: model.workflows.map((w) => ({
			key: w.key,
			name: w.name,
			states: w.states.map((s) => ({ key: s.key, name: s.name }))
		})),
		project_items: [
			...model.prompts
				.filter((p) => p.reach === 'project')
				.map((p) => ({ kind: 'prompt', name: p.name })),
			...model.skills
				.filter((p) => p.reach === 'project')
				.map((p) => ({ kind: 'skill', name: p.name })),
			...model.env.filter((p) => p.reach === 'project').map((p) => ({ kind: 'env', name: p.name })),
			...model.repos
				.filter((p) => p.reach === 'project')
				.map((p) => ({ kind: 'repo', name: p.name }))
		],
		env: model.env.map((e) => ({
			name: e.name,
			reach: loc(e),
			value: 'template' in e.value ? e.value.template : null,
			input: 'input' in e.value ? e.value.input : null
		})),
		fixed_repos: model.repos
			.filter((r) => r.url)
			.map((r) => ({ name: r.name, url: r.url!, branch: r.branch })),
		wide_states: model.workflows.flatMap((w) =>
			w.states
				.filter((s) => s.run_scope !== 'issue')
				.map((s) => ({
					workflow: w.name,
					state: s.name,
					run_scope: s.run_scope as 'project' | 'organization'
				}))
		),
		schedules: model.schedules.map((s) => ({ key: s.key, name: s.name }))
	};
}

/** What `next` adds that `prev` did not, in the same terms. */
export function addsChanged(prev: PackAdds, next: PackAdds): PackAdds {
	const has = <T>(list: T[], key: (t: T) => string) => new Set(list.map(key));
	const prevItems = has(prev.project_items, (i) => `${i.kind}:${i.name}`);
	const prevEnv = has(prev.env, (e) => `${e.reach}:${e.name}:${e.value}:${e.input}`);
	const prevRepos = has(prev.fixed_repos, (r) => `${r.name}:${r.url}:${r.branch}`);
	const prevWide = has(prev.wide_states, (s) => `${s.workflow}:${s.state}:${s.run_scope}`);
	const prevSchedules = has(prev.schedules, (s) => s.key);
	const prevWorkflows = has(prev.workflows, (w) => w.key);
	return {
		workflows: next.workflows.filter((w) => !prevWorkflows.has(w.key)),
		project_items: next.project_items.filter((i) => !prevItems.has(`${i.kind}:${i.name}`)),
		env: next.env.filter((e) => !prevEnv.has(`${e.reach}:${e.name}:${e.value}:${e.input}`)),
		fixed_repos: next.fixed_repos.filter((r) => !prevRepos.has(`${r.name}:${r.url}:${r.branch}`)),
		wide_states: next.wide_states.filter(
			(s) => !prevWide.has(`${s.workflow}:${s.state}:${s.run_scope}`)
		),
		schedules: next.schedules.filter((s) => !prevSchedules.has(s.key))
	};
}

/** Whether any state reaches past its issue, or (on Replace) reaches further than before. */
function widens(model: PackModel, prev: PackModel | null, renamed: Map<string, string>): boolean {
	const rank = { issue: 0, project: 1, organization: 2 } as const;
	const before = new Map<string, number>();
	for (const w of prev?.workflows ?? [])
		for (const s of w.states) {
			const ref =
				renamed.get(stateRef(w.key, s.key)) ?? stateRef(renamed.get(w.key) ?? w.key, s.key);
			before.set(ref, rank[s.run_scope]);
		}
	return model.workflows.some((w) =>
		w.states.some((s) => rank[s.run_scope] > (before.get(stateRef(w.key, s.key)) ?? 0))
	);
}

/**
 * Items in this project a pack's skill, env and repo items would override,
 * or that would override them (prompts append, so they never replace).
 */
async function replacements(
	db: Kysely<Database>,
	ownerId: string,
	projectId: string,
	model: PackModel,
	exceptPackId: string | null
): Promise<PackReplacement[]> {
	const names = {
		skill: model.skills.map((s) => s.name),
		env: model.env.map((s) => s.name),
		repo: model.repos.map((s) => s.name)
	};
	const all = [...names.skill, ...names.env, ...names.repo];
	if (!all.length) return [];
	const rows = await db
		.selectFrom('context_item')
		.leftJoin('pack', 'pack.id', 'context_item.pack_id')
		.leftJoin('project', 'project.id', 'context_item.project_id')
		.leftJoin('label', 'label.id', 'context_item.label_id')
		.select([
			'context_item.id',
			'context_item.kind',
			'context_item.name',
			'context_item.project_id',
			'context_item.workflow_state_id',
			'context_item.label_id',
			'context_item.issue_id',
			'context_item.pack_id',
			'context_item.reach',
			'pack.name as pack_name',
			'project.name as project_name',
			'label.name as label_name'
		])
		.where('context_item.user_id', '=', ownerId)
		.where('context_item.kind', 'in', ['skill', 'env', 'repo'])
		.where('context_item.name', 'in', all)
		.where((eb) =>
			eb.or([
				eb('context_item.project_id', 'is', null),
				eb('context_item.project_id', '=', projectId)
			])
		)
		.where((eb) =>
			exceptPackId
				? eb.or([
						eb('context_item.pack_id', 'is', null),
						eb('context_item.pack_id', '!=', exceptPackId)
					])
				: sql<boolean>`1 = 1`
		)
		.execute();
	const out: PackReplacement[] = [];
	for (const row of rows) {
		const kind = row.kind as 'skill' | 'env' | 'repo';
		if (!names[kind]?.includes(row.name)) continue;
		// Only items that can meet the pack's items on an issue: not other packs' workflow-level items,
		// and not state items on other workflows.
		if (row.pack_id && row.reach !== 'project') continue;
		if (!row.pack_id && row.workflow_state_id) continue;
		const label = row.pack_id
			? `pack ${row.pack_name} · project ${row.project_name}`
			: [
					row.project_name ? `project ${row.project_name}` : null,
					row.label_name ? `label ${row.label_name}` : null,
					row.issue_id ? 'issue' : null
				]
					.filter(Boolean)
					.join(' · ') || 'global';
		// Global and earlier packs' project items lose to the pack; the project's
		// own items, and label or issue items, win over it.
		const packWins = row.pack_id ? true : row.project_id === null && !row.label_id && !row.issue_id;
		out.push({
			kind,
			name: row.name,
			item_id: row.id,
			scope_label: label,
			direction: packWins ? 'pack_overrides' : 'overrides_pack'
		});
	}
	return out;
}

async function reviewBase(
	db: Kysely<Database>,
	pp: PackProject,
	parsed: PackParseResult,
	action: 'install' | 'replace',
	existing: PackRow | null
): Promise<PackReview> {
	const model = parsed.model;
	const base: PackReview = {
		action,
		digest: parsed.digest,
		errors: parsed.errors,
		warnings: parsed.warnings,
		model,
		adds: model ? packAdds(model) : null,
		replacements: [],
		inputs: [],
		requires_browser: false
	};
	if (!model) return base;
	base.replacements = await replacements(
		db,
		pp.actor.userId,
		pp.project.id,
		model,
		existing?.id ?? null
	);
	if (existing) {
		const views = (await loadInputViews(db, [existing], pp.personId)).get(existing.id) ?? [];
		const byName = new Map(views.map((v) => [v.name, v]));
		base.inputs = inputViews(model.manifest.inputs, [], new Map(), new Set(), existing.id).map(
			(v) => {
				const prior = byName.get(v.name);
				if (!prior || prior.decl.type !== v.decl.type) return v;
				return {
					...v,
					value: prior.value,
					my_secret_set: prior.my_secret_set,
					missing: prior.missing
				};
			}
		);
	} else {
		base.inputs = inputViews(model.manifest.inputs, [], new Map(), new Set(), '').map((v) =>
			// A workflow default names one of this pack's own workflows, which install creates.
			v.decl.type === 'workflow' && v.decl.default ? { ...v, missing: false } : v
		);
	}
	return base;
}

export async function prepareInstall(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	body: unknown
): Promise<PackReview> {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.validate');
	const parsed = await readUpload(body);
	const review = await reviewBase(db, pp, parsed, 'install', null);
	if (parsed.model) {
		review.requires_browser = widens(parsed.model, null, new Map());
		const existing = await db
			.selectFrom('pack')
			.select(['id', 'name'])
			.where('project_id', '=', projectId)
			.where('pack_key', '=', parsed.model.manifest.id)
			.executeTakeFirst();
		review.already_installed = existing ? { pack_id: existing.id, name: existing.name } : null;
	}
	return review;
}

// ---------------------------------------------------------------------------
// Install

export async function installPack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	body: unknown,
	source: { packId: string } | null = null
): Promise<PackReceipt> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.install');
	const req = (body ?? {}) as InstallPackRequest;
	const parsed = await readUpload(body);
	if (!parsed.model) throw invalidPack(parsed);
	if (typeof req.expected_digest !== 'string' || req.expected_digest !== parsed.digest)
		throw digestMismatch();
	const model = parsed.model;
	if (widens(model, null, new Map()))
		assertBrowser(pp.actor, 'This pack has states whose run scope');
	const existing = await db
		.selectFrom('pack')
		.select(['id', 'name'])
		.where('project_id', '=', projectId)
		.where('pack_key', '=', model.manifest.id)
		.executeTakeFirst();
	if (existing)
		throw new ApiFail(
			409,
			'already_installed',
			`Pack "${model.manifest.id}" is already in this project; replace it instead`,
			{
				pack_id: existing.id
			}
		);
	const authored = req.authored === true;
	const now = Date.now();
	const packId = newId('pack');
	const position =
		Number(
			(
				await db
					.selectFrom('pack')
					.select((eb) => eb.fn.max('position').as('p'))
					.where('project_id', '=', projectId)
					.executeTakeFirst()
			)?.p ?? -1
		) + 1;
	const plan = planPackWorkflows(
		db,
		model,
		{ workflows: [], states: [], transitions: [] },
		{
			ownerId: pp.actor.userId,
			packId,
			now,
			renamed: new Map()
		}
	);
	const packWorkflows = packWorkflowKeys(model, plan);
	const scheduleIds = new Map(model.schedules.map((s) => [s.key, newId('psch')]));
	const values = await resolveValues(
		db,
		pp.actor.userId,
		projectId,
		model.manifest.inputs,
		req.values,
		packWorkflows
	);
	const queries: CompiledQuery[] = [
		db
			.insertInto('pack')
			.values({
				id: packId,
				project_id: projectId,
				organization_id: null,
				pack_key: model.manifest.id,
				name: model.manifest.name,
				description: model.manifest.description,
				kind: authored ? 'authored' : 'installed',
				version: model.manifest.version,
				digest: parsed.digest,
				source_kind: source ? 'project' : 'file',
				source_pack_id: source?.packId ?? null,
				derived_from: model.manifest.derived_from
					? JSON.stringify(model.manifest.derived_from)
					: null,
				position,
				inputs: JSON.stringify(model.manifest.inputs),
				readme: model.readme,
				changelog: model.changelog,
				migrations: JSON.stringify(model.migrations),
				created_by: pp.personId,
				created_at: now,
				updated_at: now
			})
			.compile(),
		...plan.upserts,
		...packItemInsertQueries(db, model, {
			ownerId: pp.actor.userId,
			projectId,
			packId,
			ids: plan.ids,
			now
		}),
		...packScheduleInsertQueries(db, packId, model.schedules, scheduleIds),
		...valueWriteQueries(db, packId, values, now),
		...(await secretWriteQueries(
			db,
			env,
			packId,
			pp.personId,
			model.manifest.inputs,
			req.my_secrets,
			now
		)),
		...(await snapshotInsertQueries(db, packId, parsed.files))
	];
	// Suggested schedules the installer checked, created enabled.
	const created: { id: string; name: string }[] = [];
	if (req.schedules?.length) {
		const ctx = await renderContextFor(
			db,
			{
				id: packId,
				name: model.manifest.name,
				projectName: pp.project.name,
				inputs: model.manifest.inputs
			},
			values.upserts,
			knownPackWorkflows(model, plan)
		);
		const taken = await takenScheduleNames(db, projectId);
		for (const choice of req.schedules) {
			const index = model.schedules.findIndex((s) => s.key === choice.key);
			if (index === -1)
				throw new ApiFail(
					422,
					'unknown_schedule',
					`This pack suggests no schedule "${choice.key}"`
				);
			const s = model.schedules[index];
			const wf = model.workflows.find((w) => w.key === s.workflow)!;
			const out = scheduleFromSuggestionQueries(db, pp.actor, {
				projectId,
				packId,
				packScheduleId: scheduleIds.get(s.key)!,
				suggestion: s,
				workflowId: plan.ids.workflows.get(wf.key)!,
				stateId: s.start ? (plan.ids.states.get(stateRef(wf.key, s.start)) ?? null) : null,
				timezone: choice.timezone,
				ctx,
				takenNames: taken,
				now
			});
			created.push({ id: out.id, name: out.name });
			queries.push(...out.queries);
		}
	}
	const receiptId = newId('prc');
	queries.push(
		db
			.insertInto('pack_receipt')
			.values({
				id: receiptId,
				pack_id: packId,
				project_id: projectId,
				action: 'install',
				digest: parsed.digest,
				version: model.manifest.version,
				actor_user_id: pp.personId,
				receipt_json: JSON.stringify({ schedules_created: created, authored }),
				created_at: now
			})
			.compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.installed',
			projectId,
			createdAt: now,
			payload: {
				pack_id: packId,
				name: model.manifest.name,
				version: model.manifest.version,
				digest: parsed.digest
			}
		})
	);
	await runAtomic(env, queries);
	const pack = await loadPack(db, projectId, packId);
	return {
		id: receiptId,
		action: 'install',
		pack: (await summarize(db, [pack], pp.personId))[0],
		digest: parsed.digest,
		version: model.manifest.version,
		created_at: now,
		schedules_created: created
	};
}

function packWorkflowKeys(model: PackModel, plan: WorkflowWritePlan): PackWorkflowKeys {
	return new Map(
		model.workflows.map((w) => [
			w.key,
			{
				id: plan.ids.workflows.get(w.key)!,
				states: new Map(w.states.map((s) => [s.key, plan.ids.states.get(stateRef(w.key, s.key))!]))
			}
		])
	);
}

function knownPackWorkflows(model: PackModel, plan: WorkflowWritePlan) {
	return new Map(
		model.workflows.map((w) => [
			plan.ids.workflows.get(w.key)!,
			{
				name: w.name,
				initialStateId: plan.ids.states.get(stateRef(w.key, w.initial))!,
				states: new Map(w.states.map((s) => [plan.ids.states.get(stateRef(w.key, s.key))!, s.name]))
			}
		])
	);
}

// ---------------------------------------------------------------------------
// Replace

/** The files the current version of a pack consists of (for the diff). */
async function currentFiles(db: Kysely<Database>, pack: PackRow): Promise<PackFile[]> {
	return pack.kind === 'installed'
		? loadSnapshotFiles(db, pack.id)
		: writePackFiles(await packModelFromDb(db, pack));
}

function fileChanges(before: PackFile[], after: PackFile[]): PackFileChange[] {
	const prev = new Map(before.map((f) => [f.path, f]));
	const next = new Map(after.map((f) => [f.path, f]));
	const text = (f: PackFile | undefined) => {
		if (!f || f.bytes.length > 64 * 1024) return undefined;
		return fileText(f) ?? undefined;
	};
	const same = (a: Uint8Array, b: Uint8Array) =>
		a.length === b.length && a.every((v, i) => v === b[i]);
	const out: PackFileChange[] = [];
	for (const path of [...new Set([...prev.keys(), ...next.keys()])].sort()) {
		const a = prev.get(path);
		const b = next.get(path);
		if (a && b && same(a.bytes, b.bytes)) continue;
		out.push({
			path,
			change: !a ? 'added' : !b ? 'removed' : 'changed',
			...(a ? { before: text(a) } : {}),
			...(b ? { after: text(b) } : {})
		});
	}
	return out;
}

/** CHANGELOG sections for versions newer than `version` (headed `## <n>`), or the whole file. */
export function newerChangelog(changelog: string | null, version: number | null): string | null {
	if (!changelog) return null;
	const parts = changelog.split(/^(?=## )/m);
	const sections = parts.filter((p) => /^## \s*v?\d+/.test(p));
	if (sections.length === 0) return changelog;
	const newer = sections.filter((p) => Number(/^## \s*v?(\d+)/.exec(p)![1]) > (version ?? 0));
	return newer.join('').trim() || null;
}

interface ReplacePlan {
	plan: WorkflowWritePlan;
	rows: PackStateMappingRow[];
	targets: PackMappingTarget[];
	removedSuggest: Map<string, string>;
	prevModel: PackModel;
}

async function planReplace(
	db: Kysely<Database>,
	pp: PackProject,
	pack: PackRow,
	model: PackModel,
	now: number
): Promise<ReplacePlan> {
	const prevModel = await packModelFromDb(db, pack);
	const existing = await loadExistingPackWorkflows(db, pack.id);
	const { renamed, removed } = chainedRenames(model.migrations, pack.version);
	const plan = planPackWorkflows(db, model, existing, {
		ownerId: pp.actor.userId,
		packId: pack.id,
		now,
		renamed
	});
	const ids = plan.removedStates.map((s) => s.id).concat(['']);
	const removedWorkflowIds = plan.removedWorkflows.map((w) => w.id).concat(['']);
	const [issues, additions, schedules, initialSchedules] = await Promise.all([
		db
			.selectFrom('issue')
			.select(['state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where('state_id', 'in', ids)
			.groupBy('state_id')
			.execute(),
		db
			.selectFrom('context_item')
			.select(['workflow_state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where('workflow_state_id', 'in', ids)
			.where('pack_id', 'is', null)
			.groupBy('workflow_state_id')
			.execute(),
		db
			.selectFrom('scheduled_task')
			.select(['state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where('state_id', 'in', ids)
			.groupBy('state_id')
			.execute(),
		db
			.selectFrom('scheduled_task')
			.innerJoin('workflow', 'workflow.id', 'scheduled_task.workflow_id')
			.select(['workflow.initial_state_id as state_id', (eb) => eb.fn.countAll<number>().as('n')])
			.where('scheduled_task.workflow_id', 'in', removedWorkflowIds)
			.where('scheduled_task.state_id', 'is', null)
			.groupBy('workflow.initial_state_id')
			.execute()
	]);
	const n = (rows: { n: number }[], match: (r: never) => boolean) =>
		rows.filter(match as (r: unknown) => boolean).reduce((a, r) => a + Number(r.n), 0);
	// Pre-fill: `removed:` entries (as `<wf>/<state>` or `<wf>` → its initial state).
	const removedSuggest = new Map<string, string>();
	for (const s of plan.removedStates) {
		const [wfKey] = s.ref.split('/');
		const target = removed.get(s.ref) ?? removed.get(wfKey);
		if (!target) continue;
		if (target.includes('/')) removedSuggest.set(s.id, target);
		else {
			const wf = model.workflows.find((w) => w.key === target);
			if (wf) removedSuggest.set(s.id, stateRef(wf.key, wf.initial));
		}
	}
	const rows: PackStateMappingRow[] = plan.removedStates
		.map((s) => {
			const [workflowKey, stateKey] = s.ref.split('/');
			return {
				state_id: s.id,
				workflow_key: workflowKey,
				state_key: stateKey,
				workflow_name: s.workflowName,
				state_name: s.name,
				issues: n(issues, (r: { state_id: string }) => r.state_id === s.id),
				additions: n(additions, (r: { workflow_state_id: string }) => r.workflow_state_id === s.id),
				schedules:
					n(schedules, (r: { state_id: string }) => r.state_id === s.id) +
					n(initialSchedules, (r: { state_id: string }) => r.state_id === s.id),
				suggested: removedSuggest.get(s.id) ?? null
			};
		})
		.filter((r) => r.issues + r.additions + r.schedules > 0);
	// Targets: every state of the new version, then the project's other usable workflows.
	const targets: PackMappingTarget[] = model.workflows.flatMap((w) =>
		w.states.map((s) => ({ ref: stateRef(w.key, s.key), label: `${w.name} / ${s.name}` }))
	);
	if (rows.length) {
		const others = await db
			.selectFrom('workflow_state')
			.innerJoin('workflow', 'workflow.id', 'workflow_state.workflow_id')
			.leftJoin('pack', 'pack.id', 'workflow.pack_id')
			.select(['workflow_state.id', 'workflow_state.name', 'workflow.name as workflow_name'])
			.where((eb) =>
				eb.or([eb('workflow.user_id', '=', pp.actor.userId), eb('workflow.user_id', 'is', null)])
			)
			.where((eb) =>
				eb.or([
					eb('workflow.pack_id', 'is', null),
					eb.and([eb('pack.project_id', '=', pp.project.id), eb('pack.id', '!=', pack.id)])
				])
			)
			.orderBy('workflow.name')
			.orderBy('workflow_state.position')
			.execute();
		targets.push(...others.map((s) => ({ ref: s.id, label: `${s.workflow_name} / ${s.name}` })));
	}
	return { plan, rows, targets, removedSuggest, prevModel };
}

export async function prepareReplace(
	db: Kysely<Database>,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: unknown
): Promise<PackReview> {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.validate');
	const pack = await loadPack(db, projectId, packId);
	const parsed = await readUpload(body);
	return replaceReview(db, pp, pack, parsed);
}

async function replaceReview(
	db: Kysely<Database>,
	pp: PackProject,
	pack: PackRow,
	parsed: PackParseResult
): Promise<PackReview> {
	const review = await reviewBase(db, pp, parsed, 'replace', pack);
	review.current = { version: pack.version, digest: pack.digest, kind: pack.kind };
	if (!parsed.model) return review;
	const model = parsed.model;
	if (model.manifest.id !== pack.pack_key) {
		review.errors = [
			...review.errors,
			{
				level: 'error',
				code: 'different_pack',
				path: 'pack.yaml',
				message: `This is pack "${model.manifest.id}", not "${pack.pack_key}"; Replace only accepts a version of the same pack`
			}
		];
		review.model = null;
		return review;
	}
	const rp = await planReplace(db, pp, pack, model, Date.now());
	const { renamed } = chainedRenames(model.migrations, pack.version);
	review.changelog = newerChangelog(model.changelog, pack.version);
	review.files = fileChanges(await currentFiles(db, pack), parsed.files);
	review.adds_changed = addsChanged(packAdds(rp.prevModel), packAdds(model));
	review.state_mapping = rp.rows;
	review.mapping_targets = rp.targets;
	review.requires_browser = widens(model, rp.prevModel, renamed);
	review.version_warning =
		pack.version !== null &&
		model.manifest.version !== null &&
		model.manifest.version < pack.version
			? 'lower_version'
			: model.manifest.version === pack.version && parsed.digest !== pack.digest
				? 'same_version_different_digest'
				: null;
	review.discards_authored_edits =
		pack.kind === 'authored' &&
		(await packDigest(writePackFiles(rp.prevModel))) !== (pack.digest ?? '');
	return review;
}

export async function replacePack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: unknown,
	uploaded?: PackParseResult
): Promise<PackReceipt> {
	const pp = await packProject(db, actor, projectId, 'write', 'pack.replace');
	const pack = await loadPack(db, projectId, packId);
	const req = (body ?? {}) as ReplacePackRequest;
	const parsed = uploaded ?? (await readUpload(body));
	if (!parsed.model) throw invalidPack(parsed);
	if (typeof req.expected_digest !== 'string' || req.expected_digest !== parsed.digest)
		throw digestMismatch();
	const model = parsed.model;
	if (model.manifest.id !== pack.pack_key)
		throw new ApiFail(
			422,
			'different_pack',
			`This is pack "${model.manifest.id}", not "${pack.pack_key}"`
		);
	const now = Date.now();
	const rp = await planReplace(db, pp, pack, model, now);
	const { renamed } = chainedRenames(model.migrations, pack.version);
	if (widens(model, rp.prevModel, renamed))
		assertBrowser(pp.actor, 'This version widens a run scope, so it');
	const lower =
		pack.version !== null &&
		model.manifest.version !== null &&
		model.manifest.version < pack.version;
	const sameDifferent = model.manifest.version === pack.version && parsed.digest !== pack.digest;
	if ((lower || sameDifferent) && req.confirm_version !== true)
		throw new ApiFail(
			409,
			'version_confirmation_required',
			lower
				? `Version ${model.manifest.version} is older than the installed version ${pack.version}; confirm to replace anyway`
				: `This is version ${pack.version} again, with different content; confirm to replace anyway`
		);

	// Resolve the state mapping: every removed state that holds something needs a target.
	const mapping = new Map<string, { stateId: string; workflowId: string }>();
	const removedIds = new Set(rp.plan.removedStates.map((s) => s.id));
	const stateWorkflow = new Map<string, string>();
	for (const w of model.workflows)
		for (const s of w.states)
			stateWorkflow.set(
				rp.plan.ids.states.get(stateRef(w.key, s.key))!,
				rp.plan.ids.workflows.get(w.key)!
			);
	for (const row of rp.rows) {
		const ref = req.state_mapping?.[row.state_id] ?? row.suggested;
		if (!ref)
			throw new ApiFail(
				422,
				'state_mapping_required',
				`State "${row.workflow_name} / ${row.state_name}" is removed and holds ${row.issues} issue(s), ${row.additions} project addition(s) and ${row.schedules} schedule(s); map it to a state that exists after the replace`,
				{ state_id: row.state_id }
			);
		const packTarget = rp.plan.ids.states.get(ref);
		if (packTarget) {
			mapping.set(row.state_id, {
				stateId: packTarget,
				workflowId: stateWorkflow.get(packTarget)!
			});
			continue;
		}
		if (!rp.targets.some((t) => t.ref === ref) || removedIds.has(ref))
			throw new ApiFail(
				422,
				'invalid_state_mapping',
				`"${ref}" is not a state this project can use after the replace`,
				{
					state_id: row.state_id
				}
			);
		const st = await db
			.selectFrom('workflow_state')
			.select(['id', 'workflow_id'])
			.where('id', '=', ref)
			.executeTakeFirstOrThrow();
		mapping.set(row.state_id, { stateId: st.id, workflowId: st.workflow_id });
	}

	const packWorkflows = packWorkflowKeys(model, rp.plan);
	const decls = model.manifest.inputs;
	const values = await resolveValues(
		db,
		pp.actor.userId,
		projectId,
		decls,
		req.values,
		packWorkflows
	);
	const prevDecls = parseInputDecls(pack.inputs);
	// Values of inputs the new version dropped (or changed the type of) go.
	for (const [name, decl] of Object.entries(prevDecls))
		if (!decls[name] || decls[name].type !== decl.type) values.clears.push(name);
	const droppedSecrets = Object.entries(prevDecls)
		.filter(([name, d]) => d.type === 'secret' && decls[name]?.type !== 'secret')
		.map(([name]) => name);

	const queries: CompiledQuery[] = [
		// Refuse the whole batch if the pack moved since this request read it.
		sql`SELECT CASE WHEN EXISTS (SELECT 1 FROM pack WHERE id = ${pack.id} AND revision = ${pack.revision})
			THEN 1 ELSE json_extract('x', '$[') END`.compile(db),
		db
			.updateTable('pack')
			.set({
				name: model.manifest.name,
				description: model.manifest.description,
				version: model.manifest.version,
				digest: parsed.digest,
				inputs: JSON.stringify(decls),
				readme: model.readme,
				changelog: model.changelog,
				migrations: JSON.stringify(model.migrations),
				derived_from: model.manifest.derived_from
					? JSON.stringify(model.manifest.derived_from)
					: pack.derived_from,
				revision: pack.revision + 1,
				updated_at: now
			})
			.where('id', '=', pack.id)
			.compile(),
		...rp.plan.upserts,
		...(await mappingMoveQueries(db, pp.actor.userId, rp.plan, mapping, now)),
		// The pack's own items go before the removed states they may sit on.
		...packItemDeleteQueries(db, pack.id),
		...rp.plan.deletes,
		...packItemInsertQueries(db, model, {
			ownerId: pp.actor.userId,
			projectId,
			packId: pack.id,
			ids: rp.plan.ids,
			now
		})
	];
	const priorSchedules = await db
		.selectFrom('pack_schedule')
		.select(['id', 'schedule_key'])
		.where('pack_id', '=', pack.id)
		.execute();
	const keep = new Map(priorSchedules.map((s) => [s.schedule_key, s.id]));
	const dropped = priorSchedules.filter(
		(s) => !model.schedules.some((m) => m.key === s.schedule_key)
	);
	if (dropped.length)
		queries.push(
			db
				.updateTable('scheduled_task')
				.set({ pack_schedule_id: null })
				.where(
					'pack_schedule_id',
					'in',
					dropped.map((d) => d.id)
				)
				.compile()
		);
	queries.push(
		db.deleteFrom('pack_schedule').where('pack_id', '=', pack.id).compile(),
		...packScheduleInsertQueries(db, pack.id, model.schedules, keep),
		...valueWriteQueries(db, pack.id, values, now),
		...(await secretWriteQueries(db, env, pack.id, pp.personId, decls, req.my_secrets, now)),
		...(droppedSecrets.length
			? [
					db
						.deleteFrom('contributor_secret')
						.where('pack_id', '=', pack.id)
						.where('input_name', 'in', droppedSecrets)
						.compile()
				]
			: []),
		...(await snapshotInsertQueries(db, pack.id, parsed.files))
	);
	const issuesMoved = rp.rows.reduce((a, r) => a + r.issues, 0);
	const receiptId = newId('prc');
	queries.push(
		db
			.insertInto('pack_receipt')
			.values({
				id: receiptId,
				pack_id: pack.id,
				project_id: projectId,
				action: 'replace',
				digest: parsed.digest,
				version: model.manifest.version,
				actor_user_id: pp.personId,
				receipt_json: JSON.stringify({
					from: { version: pack.version, digest: pack.digest },
					mapping: Object.fromEntries([...mapping].map(([k, v]) => [k, v.stateId])),
					issues_moved: issuesMoved
				}),
				created_at: now
			})
			.compile(),
		eventInsert(db, pp.actor, {
			type: 'pack.replaced',
			projectId,
			createdAt: now,
			payload: {
				pack_id: pack.id,
				name: model.manifest.name,
				version: model.manifest.version,
				from_version: pack.version,
				digest: parsed.digest,
				issues_moved: issuesMoved
			}
		})
	);
	try {
		await runAtomic(env, queries);
	} catch (e) {
		const fresh = await loadPack(db, projectId, packId);
		if (fresh.revision !== pack.revision) throw revisionConflict(fresh);
		throw e;
	}
	const fresh = await loadPack(db, projectId, packId);
	return {
		id: receiptId,
		action: 'replace',
		pack: (await summarize(db, [fresh], pp.personId))[0],
		digest: parsed.digest,
		version: model.manifest.version,
		created_at: now,
		schedules_created: [],
		issues_moved: issuesMoved
	};
}

/**
 * Empties every removed state onto its mapped target: issues, the project's
 * additions (a prompt that meets a same-named one is appended to it; another
 * kind defers to the target's), schedules, routing rules, input bindings and
 * project defaults. Personal permission rows are left alone: a replace never
 * clears anyone's run permission.
 */
async function mappingMoveQueries(
	db: Kysely<Database>,
	ownerId: string,
	plan: WorkflowWritePlan,
	mapping: Map<string, { stateId: string; workflowId: string }>,
	now: number
): Promise<CompiledQuery[]> {
	const out: CompiledQuery[] = [];
	if (mapping.size === 0 && plan.removedWorkflows.length === 0) return out;
	const additions = await db
		.selectFrom('context_item')
		.select([
			'id',
			'kind',
			'name',
			'project_id',
			'label_id',
			'issue_id',
			'workflow_state_id',
			'body'
		])
		.where('workflow_state_id', 'in', [...mapping.keys()].concat(['']))
		.where('pack_id', 'is', null)
		.execute();
	const targets = [...new Set([...mapping.values()].map((m) => m.stateId))];
	const atTargets = await db
		.selectFrom('context_item')
		.select([
			'id',
			'kind',
			'name',
			'project_id',
			'label_id',
			'issue_id',
			'workflow_state_id',
			'body',
			'version'
		])
		.where('workflow_state_id', 'in', targets.concat(['']))
		.where('pack_id', 'is', null)
		.where('user_id', '=', ownerId)
		.execute();
	const key = (
		r: {
			kind: string;
			name: string;
			project_id: string | null;
			label_id: string | null;
			issue_id: string | null;
		},
		state: string
	) => [r.kind, r.name, r.project_id ?? '', r.label_id ?? '', r.issue_id ?? '', state].join('\0');
	const taken = new Map(atTargets.map((r) => [key(r, r.workflow_state_id!), r]));
	const appended = new Map<string, string>();
	for (const item of additions) {
		const target = mapping.get(item.workflow_state_id!)!;
		const k = key(item, target.stateId);
		const clash = taken.get(k);
		if (!clash) {
			out.push(
				db
					.updateTable('context_item')
					.set({ workflow_state_id: target.stateId, updated_at: now })
					.where('id', '=', item.id)
					.compile()
			);
			taken.set(k, { ...item, workflow_state_id: target.stateId, version: 1 });
			continue;
		}
		if (item.kind === 'prompt') {
			const body = `${appended.get(clash.id) ?? clash.body ?? ''}`.trim();
			appended.set(clash.id, `${body}\n\n${(item.body ?? '').trim()}`.trim());
		}
		out.push(
			db.deleteFrom('context_item_file').where('context_item_id', '=', item.id).compile(),
			db.deleteFrom('context_item').where('id', '=', item.id).compile()
		);
	}
	for (const [id, body] of appended)
		out.push(
			db
				.updateTable('context_item')
				.set({ body, version: sql`version + 1`, updated_at: now })
				.where('id', '=', id)
				.compile()
		);
	for (const [from, to] of mapping) {
		out.push(
			db
				.updateTable('issue')
				.set({
					state_id: to.stateId,
					workflow_id: to.workflowId,
					state_entered_at: now,
					updated_at: now,
					decision_revision: sql`decision_revision + 1`
				})
				.where('state_id', '=', from)
				.compile(),
			db
				.updateTable('scheduled_task')
				.set({ state_id: to.stateId, workflow_id: to.workflowId, updated_at: now })
				.where('state_id', '=', from)
				.compile(),
			sql`UPDATE OR IGNORE routing_rule SET workflow_state_id = ${to.stateId}, updated_at = ${now}
				WHERE workflow_state_id = ${from}`.compile(db),
			db.deleteFrom('routing_rule').where('workflow_state_id', '=', from).compile(),
			db
				.updateTable('pack_input_value')
				.set({ state_id: to.stateId, workflow_id: to.workflowId })
				.where('state_id', '=', from)
				.compile()
		);
	}
	// A removed workflow: schedules on its initial state, defaults and bindings follow that state's mapping.
	for (const wf of plan.removedWorkflows) {
		const initial = await db
			.selectFrom('workflow')
			.select('initial_state_id')
			.where('id', '=', wf.id)
			.executeTakeFirst();
		const to = initial ? mapping.get(initial.initial_state_id) : undefined;
		// Without a mapping the workflow held no schedules (the review requires one otherwise).
		if (to)
			out.push(
				db
					.updateTable('scheduled_task')
					.set({ workflow_id: to.workflowId, state_id: to.stateId, updated_at: now })
					.where('workflow_id', '=', wf.id)
					.compile()
			);
		out.push(
			db
				.updateTable('project')
				.set({ default_workflow_id: to?.workflowId ?? null })
				.where('default_workflow_id', '=', wf.id)
				.compile(),
			to
				? db
						.updateTable('pack_input_value')
						.set({ workflow_id: to.workflowId })
						.where('workflow_id', '=', wf.id)
						.where('state_id', 'is', null)
						.compile()
				: db.deleteFrom('pack_input_value').where('workflow_id', '=', wf.id).compile()
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Export

export async function exportPack(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string
): Promise<PackExport> {
	const pp = await packProject(db, actor, projectId, 'read', 'pack.export');
	const pack = await loadPack(db, projectId, packId);
	return exportRow(db, env, pp.actor, pack);
}

/** Exports a pack row: an authored pack takes the next version if its content changed. */
export async function exportRow(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	pack: PackRow
): Promise<PackExport> {
	const wire = (files: PackFile[]) =>
		files.map((f) => ({ path: f.path, content_b64: bytesToB64(f.bytes) }));
	const filename = (v: number) => `${packFolderName(pack.pack_key)}-v${v}.tinespack`;
	if (pack.kind === 'installed') {
		const files = await loadSnapshotFiles(db, pack.id);
		return {
			pack_key: pack.pack_key,
			version: pack.version ?? 0,
			digest: pack.digest ?? (await packDigest(files)),
			filename: filename(pack.version ?? 0),
			files: wire(files),
			new_version: false
		};
	}
	const model = await packModelFromDb(db, pack);
	const atCurrent = writePackFiles(model);
	const currentDigest = await packDigest(atCurrent);
	if (pack.version !== null && currentDigest === pack.digest)
		return {
			pack_key: pack.pack_key,
			version: pack.version,
			digest: currentDigest,
			filename: filename(pack.version),
			files: wire(atCurrent),
			new_version: false
		};
	const version = (pack.version ?? 0) + 1;
	const files = writePackFiles({ ...model, manifest: { ...model.manifest, version } });
	const digest = await packDigest(files);
	const now = Date.now();
	const results = await runAtomic(env, [
		db
			.updateTable('pack')
			.set({ version, digest, revision: pack.revision + 1, updated_at: now })
			.where('id', '=', pack.id)
			.where('revision', '=', pack.revision)
			.compile(),
		...(await snapshotInsertQueries(db, pack.id, files)).map((q) => q),
		eventInsert(db, actor, {
			type: 'pack.exported',
			projectId: pack.project_id ?? undefined,
			createdAt: now,
			payload: { pack_id: pack.id, name: pack.name, version, digest }
		})
	]);
	if ((results[0]?.meta.changes ?? 0) === 0) {
		// Someone exported (or edited) concurrently: export what is there now.
		const fresh = await db
			.selectFrom('pack')
			.selectAll()
			.where('id', '=', pack.id)
			.executeTakeFirst();
		if (!fresh) throw notFound();
		return exportRow(db, env, actor, fresh);
	}
	return {
		pack_key: pack.pack_key,
		version,
		digest,
		filename: filename(version),
		files: wire(files),
		new_version: true
	};
}

// ---------------------------------------------------------------------------
// Sources: packs in other projects the person can read

export async function listSourceCandidates(
	db: Kysely<Database>,
	actor: ActorContext,
	exceptProjectId: string | null
) {
	const rows = await db
		.selectFrom('pack')
		.innerJoin('project', 'project.id', 'pack.project_id')
		.leftJoin('project_member as m', (join) =>
			join.onRef('m.project_id', '=', 'project.id').on('m.user_id', '=', actor.userId)
		)
		.select([
			'pack.id',
			'pack.pack_key',
			'pack.name',
			'pack.description',
			'pack.kind',
			'pack.version',
			'project.id as project_id',
			'project.name as project_name'
		])
		.where((eb) =>
			eb.or([
				eb('project.user_id', '=', actor.userId),
				eb.and([
					eb('project.shared_at', 'is not', null),
					eb('m.revoked_at', 'is', null),
					eb('m.revision', 'is not', null)
				])
			])
		)
		.where('project.archived_at', 'is', null)
		.orderBy('project.name')
		.orderBy('pack.position')
		.execute();
	return rows
		.filter(
			(r) =>
				r.project_id !== exceptProjectId &&
				accessAllowed(
					actor,
					[{ domain: 'project', access: 'read', projectId: r.project_id }],
					'pack.read',
					{
						projectId: r.project_id
					}
				)
		)
		.map((r) => ({
			pack_id: r.id,
			pack_key: r.pack_key,
			name: r.name,
			description: r.description,
			kind: r.kind,
			version: r.version,
			project_id: r.project_id,
			project_name: r.project_name
		}));
}

/** The current content of a source pack, as an upload (an authored source is exported now). */
export async function sourceUpload(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	sourcePackId: string
): Promise<{ files: { path: string; content_b64: string }[]; source: PackRow }> {
	const source = await db
		.selectFrom('pack')
		.selectAll()
		.where('id', '=', sourcePackId)
		.executeTakeFirst();
	if (!source?.project_id) throw notFound();
	const scoped = await actorForProject(db, actor, source.project_id);
	await packProject(db, actor, source.project_id, 'read', 'pack.export');
	const exported = await exportRow(db, env, scoped, source);
	return { files: exported.files, source };
}

export async function prepareInstallFromSource(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	sourcePackId: string
): Promise<PackReview> {
	const { files } = await sourceUpload(db, env, actor, sourcePackId);
	return prepareInstall(db, actor, projectId, { files });
}

export async function installFromSource(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	sourcePackId: string,
	body: unknown
): Promise<PackReceipt> {
	const { files, source } = await sourceUpload(db, env, actor, sourcePackId);
	return installPack(
		db,
		env,
		actor,
		projectId,
		{ ...(body as object), files },
		{ packId: source.id }
	);
}

/** Update from source: the replace review against the source pack's current content. */
export async function prepareUpdateFromSource(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string
): Promise<PackReview> {
	const pack = await loadPack(db, projectId, packId);
	if (!pack.source_pack_id)
		throw new ApiFail(422, 'no_source', 'This pack was not installed from another project');
	const { files } = await sourceUpload(db, env, actor, pack.source_pack_id);
	return prepareReplace(db, actor, projectId, packId, { files });
}

export async function updateFromSource(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	projectId: string,
	packId: string,
	body: unknown
): Promise<PackReceipt> {
	const pack = await loadPack(db, projectId, packId);
	if (!pack.source_pack_id)
		throw new ApiFail(422, 'no_source', 'This pack was not installed from another project');
	const { files } = await sourceUpload(db, env, actor, pack.source_pack_id);
	return replacePack(db, env, actor, projectId, packId, { ...(body as object), files });
}

/** A random pack id for a pack created (or detached) in Tines. */
export function randomPackKey(): string {
	return `p-${randomString(12).toLowerCase()}`;
}
