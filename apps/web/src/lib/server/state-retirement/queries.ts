import { sql, type CompiledQuery, type Kysely, type RawBuilder } from 'kysely';
import type {
	StateRetirementInventoryV1,
	StateRetirementPlanV1,
	StateRetirementReceiptV1
} from '@tines/shared';
import type { Database } from '$lib/server/db';
import type { ActorContext } from '../api/core';
import type { RetirementPlanTokenPayload } from './token';

/**
 * One stable, owner-scoped SQL witness for inventory and the later guarded
 * apply. JSON rows include every field that can change matching, ordering,
 * payload bytes, topology, or the drain decision. Artifact growth is excluded.
 */
export function retirementWitnessExpression(userId: string): RawBuilder<string> {
	return sql<string>`json_object(
				'workflows', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'user_id', user_id, 'name', name,
						'description', description, 'initial_state_id', initial_state_id,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM workflow WHERE user_id = ${userId} OR user_id IS NULL ORDER BY id
				)), '[]'),
				'states', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', s.id, 'workflow_id', s.workflow_id, 'name', s.name,
						'category', s.category, 'position', s.position,
						'inherits_from_state_id', s.inherits_from_state_id, 'created_at', s.created_at) AS row_json
					FROM workflow_state s JOIN workflow w ON w.id = s.workflow_id
					WHERE w.user_id = ${userId} OR w.user_id IS NULL ORDER BY s.id
				)), '[]'),
				'transitions', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', t.id, 'workflow_id', t.workflow_id, 'name', t.name,
						'from_state_id', t.from_state_id, 'to_state_id', t.to_state_id,
						'requirements', t.requirements) AS row_json
					FROM workflow_transition t JOIN workflow w ON w.id = t.workflow_id
					WHERE w.user_id = ${userId} OR w.user_id IS NULL ORDER BY t.id
				)), '[]'),
				'projects', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'name', name, 'description', description,
						'default_workflow_id', default_workflow_id, 'archived_at', archived_at,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM project WHERE user_id = ${userId} ORDER BY id
				)), '[]'),
				'labels', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'name', name, 'color', color,
						'description', description, 'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM label WHERE user_id = ${userId} ORDER BY id
				)), '[]'),
				'issues', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', i.id, 'project_id', i.project_id, 'number', i.number,
						'workflow_id', i.workflow_id, 'state_id', i.state_id,
						'project_assignment_token', i.project_assignment_token,
						'created_at', i.created_at, 'updated_at', i.updated_at) AS row_json
					FROM issue i JOIN project p ON p.id = i.project_id WHERE p.user_id = ${userId} ORDER BY i.id
				)), '[]'),
				'issue_labels', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('issue_id', il.issue_id, 'label_id', il.label_id,
						'created_at', il.created_at) AS row_json
					FROM issue_label il JOIN issue i ON i.id = il.issue_id JOIN project p ON p.id = i.project_id
					WHERE p.user_id = ${userId} ORDER BY il.issue_id, il.label_id
				)), '[]'),
				'context_items', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'kind', kind, 'name', name, 'description', description,
						'project_id', project_id, 'workflow_state_id', workflow_state_id,
						'issue_id', issue_id, 'label_id', label_id, 'body', body,
						'repo_url', repo_url, 'repo_branch', repo_branch, 'repo_dir', repo_dir,
						'config', config, 'env_hint', env_hint,
						'env_secret', CASE WHEN env_value_enc IS NOT NULL THEN 1 ELSE 0 END,
						'position', position, 'version', version,
						'created_at', created_at, 'updated_at', updated_at) AS row_json
					FROM context_item WHERE user_id = ${userId} AND kind != 'artifact' ORDER BY id
				)), '[]'),
				'context_files', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', f.id, 'context_item_id', f.context_item_id, 'path', f.path,
						'content', f.content, 'created_at', f.created_at, 'updated_at', f.updated_at) AS row_json
					FROM context_item_file f JOIN context_item c ON c.id = f.context_item_id
					WHERE c.user_id = ${userId} AND c.kind != 'artifact' ORDER BY f.context_item_id, f.path, f.id
				)), '[]'),
				'active_runs', COALESCE((SELECT json_group_array(json(row_json)) FROM (
					SELECT json_object('id', id, 'issue_id', issue_id, 'status', status,
						'state_id_at_start', state_id_at_start, 'created_at', created_at,
						'started_at', started_at) AS row_json
					FROM agent_run WHERE user_id = ${userId}
						AND status IN ('assigned', 'launching', 'running') ORDER BY id
				)), '[]')
			)`;
}

export async function readRetirementWitness(db: Kysely<Database>, userId: string): Promise<string> {
	const row = await db
		.selectNoFrom([retirementWitnessExpression(userId).as('witness')])
		.executeTakeFirstOrThrow();
	return row.witness;
}

export const RETIREMENT_BATCH_LIMITS = {
	statements: 800,
	parameters_per_statement: 90,
	sql_bytes_per_statement: 90 * 1024,
	value_bytes: 1024 * 1024
} as const;

const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;

export interface RetirementBatchSize {
	statements: number;
	max_parameters: number;
	max_sql_bytes: number;
	max_value_bytes: number;
}

export function validateRetirementBatch(queries: readonly CompiledQuery[]): RetirementBatchSize {
	if (queries.length > RETIREMENT_BATCH_LIMITS.statements)
		throw new Error(`retirement batch exceeds ${RETIREMENT_BATCH_LIMITS.statements} statements`);
	const size: RetirementBatchSize = {
		statements: queries.length,
		max_parameters: 0,
		max_sql_bytes: 0,
		max_value_bytes: 0
	};
	queries.forEach((query, index) => {
		if (query.parameters.length > RETIREMENT_BATCH_LIMITS.parameters_per_statement)
			throw new Error(`retirement statement ${index} exceeds parameter budget`);
		const sqlBytes = utf8(query.sql);
		if (sqlBytes > RETIREMENT_BATCH_LIMITS.sql_bytes_per_statement)
			throw new Error(`retirement statement ${index} exceeds SQL budget`);
		size.max_parameters = Math.max(size.max_parameters, query.parameters.length);
		size.max_sql_bytes = Math.max(size.max_sql_bytes, sqlBytes);
		for (const value of query.parameters) {
			const bytes =
				typeof value === 'string'
					? utf8(value)
					: value instanceof ArrayBuffer || ArrayBuffer.isView(value)
						? value.byteLength
						: 0;
			if (bytes > RETIREMENT_BATCH_LIMITS.value_bytes)
				throw new Error(`retirement statement ${index} exceeds value budget`);
			size.max_value_bytes = Math.max(size.max_value_bytes, bytes);
		}
	});
	return size;
}

function gate(
	executionNonce: string,
	planId: string,
	userId: string,
	requestDigest: string
): RawBuilder<boolean> {
	return sql<boolean>`EXISTS (SELECT 1 FROM state_retirement_receipt WHERE id=${planId} AND user_id=${userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce})`;
}

function scopeWhere(
	scope: {
		project_id: string | null;
		workflow_state_id: string | null;
		label_id: string | null;
		issue_id: string | null;
	},
	alias = 'c'
): RawBuilder<boolean> {
	return sql<boolean>`${sql.id(alias)}.project_id IS ${scope.project_id === null ? sql`NULL` : sql`${scope.project_id}`} AND ${sql.id(alias)}.workflow_state_id IS ${scope.workflow_state_id === null ? sql`NULL` : sql`${scope.workflow_state_id}`} AND ${sql.id(alias)}.label_id IS ${scope.label_id === null ? sql`NULL` : sql`${scope.label_id}`} AND ${sql.id(alias)}.issue_id IS ${scope.issue_id === null ? sql`NULL` : sql`${scope.issue_id}`}`;
}

/** The complete Release-A write batch. It is also compiled during prepare so
 * the signed budget describes the exact SQL which apply will submit. */
export function compileRetirementQueries(
	db: Kysely<Database>,
	actor: ActorContext,
	token: RetirementPlanTokenPayload,
	inventory: StateRetirementInventoryV1,
	plan: StateRetirementPlanV1,
	requestDigest: string,
	executionNonce: string,
	receipt: StateRetirementReceiptV1
): CompiledQuery[] {
	const witness = JSON.stringify(inventory.witness);
	const receiptJson = JSON.stringify(receipt);
	const receiptGate = gate(executionNonce, token.id, actor.userId, requestDigest);
	const held = token.held_states;
	const pointerGuards = plan.rollback.original_pointers.map(
		(pointer) => sql<boolean>`EXISTS (
		SELECT 1 FROM workflow_state s WHERE s.id=${pointer.child_state_id} AND s.inherits_from_state_id=${pointer.parent_state_id}
	)`
	);
	const destinationGuards = plan.allocations.map(
		(allocation) => sql<boolean>`NOT EXISTS (
		SELECT 1 FROM context_item c WHERE c.user_id=${actor.userId} AND c.kind=(SELECT kind FROM context_item WHERE id=${allocation.source_item_id}) AND c.name=${allocation.name} AND ${scopeWhere(allocation.scope)}
	)`
	);
	const activeRunGuard = sql<boolean>`NOT EXISTS (SELECT 1 FROM agent_run r WHERE r.user_id=${actor.userId} AND r.status IN ('assigned','launching','running') AND r.state_id_at_start IN (${sql.join(held.map((id) => sql`${id}`))}))`;
	const holdGuard = sql<boolean>`EXISTS (SELECT 1 FROM state_retirement_hold h WHERE h.id=${token.hold_id} AND h.user_id=${actor.userId} AND h.topology_digest=${token.topology_digest} AND h.released_at IS NULL) AND (SELECT COUNT(*) FROM state_retirement_hold_state hs WHERE hs.hold_id=${token.hold_id} AND hs.user_id=${actor.userId})=${held.length}`;
	const and = sql` AND `;
	const topologyAndDestinations = sql.join(
		[...pointerGuards, ...destinationGuards].length
			? [...pointerGuards, ...destinationGuards]
			: [sql<boolean>`1`],
		and
	);
	const first = sql`INSERT INTO state_retirement_receipt
		(id,user_id,hold_id,actor_key,kind,rollback_of_receipt_id,inventory_digest,plan_digest,request_digest,execution_nonce,receipt_json,committed_at)
		SELECT ${token.id},${actor.userId},${token.hold_id},${token.actor_key},'preserve',NULL,${token.inventory_digest},${token.plan_digest},${requestDigest},${executionNonce},${receiptJson},${receipt.committed_at}
		WHERE ${holdGuard} AND ${retirementWitnessExpression(actor.userId)}=${witness} AND ${activeRunGuard}
			AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < ${token.expires_at}
			AND ${topologyAndDestinations}`.compile(db);
	const queries: CompiledQuery[] = [first];
	for (const operation of plan.proposed_operations) {
		if (operation.kind !== 'copy_context_item') continue;
		const item = operation.payload.item;
		const allocation = operation.allocation;
		queries.push(
			sql`INSERT INTO context_item
			(id,user_id,kind,name,description,project_id,workflow_state_id,label_id,issue_id,body,repo_url,repo_branch,repo_dir,env_value,env_value_enc,env_hint,position,version,created_at,updated_at)
			SELECT ${allocation.copy_item_id},${actor.userId},${item.kind},${allocation.name},${item.description},${allocation.scope.project_id},${allocation.scope.workflow_state_id},${allocation.scope.label_id},${allocation.scope.issue_id},${item.body},${item.repo_url},${item.repo_branch},${item.repo_dir},NULL,NULL,${item.env_hint ?? null},${allocation.position},1,${receipt.committed_at},${receipt.committed_at}
			WHERE ${receiptGate}`.compile(db)
		);
		for (const file of operation.payload.files)
			queries.push(
				sql`INSERT INTO context_item_file (id,context_item_id,path,content,created_at,updated_at)
				SELECT ${file.id},${allocation.copy_item_id},${file.path},${file.content},${receipt.committed_at},${receipt.committed_at} WHERE ${receiptGate}`.compile(
					db
				)
			);
		queries.push(
			sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,issue_id,project_id,payload,created_at)
			SELECT ${`evt_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`},${actor.userId},'context.created',${actor.userId},${actor.apiKeyId},${allocation.scope.issue_id},${allocation.scope.project_id},${JSON.stringify({ context_id: allocation.copy_item_id, kind: item.kind, name: allocation.name, retirement_receipt_id: receipt.id })},${receipt.committed_at} WHERE ${receiptGate}`.compile(
				db
			)
		);
	}
	for (const pointer of plan.rollback.original_pointers) {
		queries.push(
			sql`UPDATE workflow_state SET inherits_from_state_id=NULL WHERE id=${pointer.child_state_id} AND inherits_from_state_id=${pointer.parent_state_id} AND ${receiptGate}`.compile(
				db
			)
		);
		queries.push(
			sql`UPDATE state_retirement_pointer SET successful_receipt_id=${receipt.id} WHERE hold_id=${token.hold_id} AND user_id=${actor.userId} AND child_state_id=${pointer.child_state_id} AND original_parent_state_id=${pointer.parent_state_id} AND ${receiptGate}`.compile(
				db
			)
		);
	}
	const workflows = [
		...new Set(
			plan.rollback.original_pointers
				.map(
					(pointer) =>
						inventory.witness.states.find((state) => state.id === pointer.child_state_id)
							?.workflow_id
				)
				.filter((id): id is string => !!id)
		)
	];
	for (const workflowId of workflows)
		queries.push(
			sql`INSERT INTO event (id,user_id,type,actor_user_id,actor_api_key_id,issue_id,project_id,payload,created_at)
			SELECT ${`evt_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`},${actor.userId},'workflow.updated',${actor.userId},${actor.apiKeyId},NULL,NULL,${JSON.stringify({ workflow_id: workflowId, retirement_receipt_id: receipt.id })},${receipt.committed_at} WHERE ${receiptGate}`.compile(
				db
			)
		);
	queries.push(
		sql`SELECT receipt_json FROM state_retirement_receipt WHERE id=${token.id} AND user_id=${actor.userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce}`.compile(
			db
		)
	);
	return queries;
}
