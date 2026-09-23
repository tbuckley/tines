import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely';
import type { Database } from '$lib/server/db';
import type { LabelColor, StateCategory } from '@tines/shared';
import type { ActorContext } from '$lib/server/api/core';
import { projectExpressionReadPredicate } from '$lib/server/api/permissions';

export interface DestinationWorkflow {
	id: string;
	user_id: string | null;
	name: string;
	description: string;
	initial_state_id: string;
	updated_at: number;
	states: {
		id: string;
		name: string;
		category: StateCategory;
		position: number;
		inherits_from_state_id: string | null;
	}[];
	transitions: {
		id: string;
		name: string;
		from_state_id: string;
		to_state_id: string;
		requirements: string | null;
	}[];
}
export interface DestinationProject {
	id: string;
	user_id: string;
	name: string;
	archived_at: number | null;
}
export interface DestinationLabel {
	id: string;
	user_id: string;
	name: string;
	color: LabelColor;
}
export interface DestinationSchedule {
	id: string;
	project_id: string;
	name: string;
}
export interface DestinationRule {
	id: string;
	project_id: string | null;
	workflow_state_id: string | null;
	label_id: string | null;
	targets: string;
}
export interface DestinationRunner {
	id: string;
	name: string;
	type: string;
	status: string;
	default_tier: string;
	tiers: string | null;
	config: string;
	has_api_key: number;
}
/** Stable capability/configuration data only. Never credentials or volatile availability. */
export interface PackageDestination {
	workflows: DestinationWorkflow[];
	projects: DestinationProject[];
	labels: DestinationLabel[];
	schedules: DestinationSchedule[];
	rules: DestinationRule[];
	runners: DestinationRunner[];
}
export interface DestinationSelection {
	workflow_ids: string[];
	workflow_names: string[];
	project_ids: string[];
	label_ids: string[];
	label_names: string[];
	schedules: { project_id: string; name: string }[];
	routing_scopes: { project_id: string | null; state_id: string }[];
	runner_ids: string[];
}

const jsonList = (query: RawBuilder<unknown>) =>
	sql`(SELECT json_group_array(json(row_json)) FROM (${query}))`;
const jsonRow = (table: string, columns: string[]) =>
	sql`json_object(${sql.join(columns.flatMap((c) => [sql.lit(c), sql.ref(`${table}.${c}`)]))})`;
const inList = (column: string, values: string[]) =>
	sql<boolean>`${sql.ref(column)} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
const choice = (
	selected: DestinationSelection | undefined,
	predicate: () => RawBuilder<SqlBool>
) => (selected ? predicate() : sql<boolean>`1`);

/**
 * One SQL projection for coherent reads and transaction-time equality guards.
 * Selection is a set of reviewed identities plus absence predicates, not a
 * whole-account version: unrelated edits and heartbeats do not stale a plan.
 */
export function packageDestinationExpression(
	actor: ActorContext,
	selected?: DestinationSelection
): RawBuilder<string> {
	const userId = actor.userId;
	const workflowPredicate = choice(
		selected,
		() =>
			sql<boolean>`(${inList('w.id', selected!.workflow_ids)} OR ${inList('w.name', selected!.workflow_names)})`
	);
	const authorizedProject = projectExpressionReadPredicate(actor, sql<string | null>`p.id`);
	const projectPredicate = sql<boolean>`${authorizedProject} AND ${choice(selected, () => inList('p.id', selected!.project_ids))}`;
	const labelPredicate = choice(
		selected,
		() =>
			sql<boolean>`(${inList('l.id', selected!.label_ids)} OR l.name COLLATE NOCASE IN (SELECT value FROM json_each(${JSON.stringify(selected!.label_names)})))`
	);
	const schedulePredicate = choice(
		selected,
		() =>
			sql<boolean>`EXISTS (SELECT 1 FROM json_each(${JSON.stringify(selected!.schedules)}) picked WHERE json_extract(picked.value,'$.project_id') = s.project_id AND json_extract(picked.value,'$.name') = s.name)`
	);
	const rulePredicate = choice(
		selected,
		() =>
			sql<boolean>`r.label_id IS NULL AND EXISTS (SELECT 1 FROM json_each(${JSON.stringify(selected!.routing_scopes)}) picked WHERE (r.project_id IS NULL OR r.project_id = json_extract(picked.value,'$.project_id')) AND (r.workflow_state_id IS NULL OR r.workflow_state_id = json_extract(picked.value,'$.state_id')))`
	);
	const runnerPredicate = choice(selected, () => inList('r.id', selected!.runner_ids));
	const workflows = jsonList(sql`SELECT json_object(
  'id',w.id,'user_id',w.user_id,'name',w.name,'description',w.description,
  'initial_state_id',w.initial_state_id,'updated_at',w.updated_at,
  'states', ${jsonList(sql`SELECT ${jsonRow('s', ['id', 'name', 'category', 'position', 'inherits_from_state_id'])} AS row_json FROM workflow_state s WHERE s.workflow_id=w.id ORDER BY s.position,s.id`)},
  'transitions', ${jsonList(sql`SELECT ${jsonRow('t', ['id', 'name', 'from_state_id', 'to_state_id', 'requirements'])} AS row_json FROM workflow_transition t WHERE t.workflow_id=w.id ORDER BY t.id`)}
 ) AS row_json FROM workflow w WHERE (w.user_id=${userId} OR w.user_id IS NULL) AND ${workflowPredicate} ORDER BY w.id`);
	return sql<string>`json_object(
  'workflows',${workflows},
	  'projects',${jsonList(sql`SELECT ${jsonRow('p', ['id', 'user_id', 'name', 'archived_at'])} AS row_json FROM project p WHERE p.user_id=${userId} AND ${projectPredicate} ORDER BY p.id`)},
  'labels',${jsonList(sql`SELECT ${jsonRow('l', ['id', 'user_id', 'name', 'color'])} AS row_json FROM label l WHERE l.user_id=${userId} AND ${labelPredicate} ORDER BY l.id`)},
	  'schedules',${jsonList(sql`SELECT ${jsonRow('s', ['id', 'project_id', 'name'])} AS row_json FROM scheduled_task s JOIN project p ON p.id=s.project_id WHERE p.user_id=${userId} AND ${authorizedProject} AND ${schedulePredicate} ORDER BY s.id`)},
	  'rules',${jsonList(sql`SELECT ${jsonRow('r', ['id', 'project_id', 'workflow_state_id', 'label_id', 'targets'])} AS row_json FROM routing_rule r WHERE r.user_id=${userId} AND (r.project_id IS NULL OR ${projectExpressionReadPredicate(actor, sql<string | null>`r.project_id`)}) AND ${rulePredicate} ORDER BY r.id`)},
  'runners',${jsonList(sql`SELECT json_object('id',r.id,'name',r.name,'type',r.type,'status',r.status,'default_tier',r.default_tier,'tiers',r.tiers,'config',r.config,'has_api_key',CASE WHEN r.secret_enc IS NULL THEN 0 ELSE 1 END) AS row_json FROM runner r WHERE r.user_id=${userId} AND ${runnerPredicate} ORDER BY r.id`)}
 )`;
}
export async function readPackageDestination(
	db: Kysely<Database>,
	actor: ActorContext,
	selected?: DestinationSelection
) {
	const row = await sql<{
		projection: string;
	}>`SELECT ${packageDestinationExpression(actor, selected)} AS projection`.execute(db);
	const raw = row.rows[0].projection;
	return { raw, data: JSON.parse(raw) as PackageDestination };
}

/** Trusted browser-session/test helper; API callers must keep the actor-aware path. */
export async function readPackageDestinationInternal(
	db: Kysely<Database>,
	userId: string,
	selected?: DestinationSelection
) {
	return readPackageDestination(
		db,
		{
			userId,
			userName: '',
			apiKeyId: null,
			apiKeyName: null,
			viaSession: true,
			runRestriction: null
		},
		selected
	);
}

/** Same selection semantics as SQL; applied to the coherent initial read. */
export function selectPackageDestination(
	data: PackageDestination,
	selected: DestinationSelection
): PackageDestination {
	return {
		workflows: data.workflows.filter(
			(w) => selected.workflow_ids.includes(w.id) || selected.workflow_names.includes(w.name)
		),
		projects: data.projects.filter((p) => selected.project_ids.includes(p.id)),
		labels: data.labels.filter(
			(l) =>
				selected.label_ids.includes(l.id) ||
				selected.label_names.some((n) => sqliteNoCase(n) === sqliteNoCase(l.name))
		),
		schedules: data.schedules.filter((s) =>
			selected.schedules.some((p) => p.project_id === s.project_id && p.name === s.name)
		),
		rules: data.rules.filter(
			(r) =>
				r.label_id === null &&
				selected.routing_scopes.some(
					(p) =>
						(r.project_id === null || r.project_id === p.project_id) &&
						(r.workflow_state_id === null || r.workflow_state_id === p.state_id)
				)
		),
		runners: data.runners.filter((r) => selected.runner_ids.includes(r.id))
	};
}
/** SQLite NOCASE only folds ASCII; JS toLowerCase would disagree on Unicode. */
export const sqliteNoCase = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
