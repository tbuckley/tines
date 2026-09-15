import { sql, type Kysely, type CompiledQuery } from 'kysely';
import type { Database } from '$lib/server/db';
import type { ActorContext } from '../api/core';
import { packageDestinationExpression } from './destination';
import { compilePackageObjects } from './compile';
import type { ResolvedPackage } from './resolve';
import type { PackagePlanPayload } from './token';
import type { WorkflowPackageReceipt } from '@tines/shared';

export function packageReceipt(
	plan: PackagePlanPayload,
	resolved: ResolvedPackage,
	mainId: string,
	now: number
): WorkflowPackageReceipt {
	const objects: WorkflowPackageReceipt['objects'] = [];
	for (const w of resolved.workflows) {
		const workflowId = plan.allocation.records[w.id].id;
		objects.push({
			kind: 'workflow',
			local_id: w.id,
			id: workflowId,
			name: w.name,
			href: `/workflows/${workflowId}`,
			relationship: w.id === mainId ? 'main' : 'dependency'
		});
		for (const state of w.states)
			objects.push({
				kind: 'state',
				local_id: state.id,
				id: plan.allocation.records[state.id].id,
				name: state.name,
				href: `/workflows/${workflowId}#state-${plan.allocation.records[state.id].id}`
			});
		for (const transition of w.transitions)
			objects.push({
				kind: 'transition',
				local_id: transition.id,
				id: plan.allocation.records[transition.id].id,
				name: transition.name,
				href: `/workflows/${workflowId}`
			});
	}
	for (const c of resolved.context) {
		const workflowId =
			plan.allocation.records[
				resolved.workflows.find((w) => w.states.some((s) => s.id === c.state_id))!.id
			].id;
		const href = `/context?workflow=${workflowId}&q=${encodeURIComponent(c.name)}`;
		objects.push({
			kind: c.kind,
			local_id: c.id,
			id: plan.allocation.records[c.id].id,
			name: c.name,
			href
		});
		if (c.kind === 'skill')
			for (const file of c.files)
				objects.push({
					kind: 'file',
					local_id: file.id,
					id: plan.allocation.records[file.id].id,
					name: file.path,
					href
				});
	}
	for (const input of resolved.inputs)
		if (input.mode === 'create')
			objects.push({
				kind: 'label',
				local_id: input.input_id,
				id: input.id!,
				name: input.value,
				href: '/labels'
			});
	for (const s of resolved.schedules)
		objects.push({
			kind: 'schedule',
			local_id: s.local_id,
			id: plan.allocation.records[s.local_id].id,
			name: s.definition.name,
			href: `/projects/${s.project_id}?schedule=${plan.allocation.records[s.local_id].id}`
		});
	for (const r of resolved.routing)
		objects.push({
			kind: 'routing',
			local_id: r.local_id,
			id: r.id,
			name: r.tier,
			href: '/agents#routing'
		});
	return {
		id: plan.id,
		document_digest: plan.document_digest,
		plan_digest: plan.plan_digest,
		committed_at: now,
		objects,
		reused_inputs: resolved.inputs
			.filter((i) => i.mode === 'reuse')
			.map((i) => ({ input_id: i.input_id, type: i.type, id: i.id!, name: i.value })),
		...(plan.source ? { source: plan.source } : {})
	};
}
/**
 * The exact receipt gate and final SELECT are compiled in prepare too, so limits
 * include their real parameters/SQL/value sizes. F's installer owns execution.
 * An old receipt cannot authorize this attempt: every child checks a fresh nonce.
 */
export function compilePackageInstall(
	db: Kysely<Database>,
	actor: ActorContext,
	plan: PackagePlanPayload,
	resolved: ResolvedPackage,
	witnessRaw: string,
	requestDigest: string,
	executionNonce: string,
	receipt: WorkflowPackageReceipt
): CompiledQuery[] {
	const sourceGuard = plan.source
		? sql<boolean>`EXISTS (
			SELECT 1 FROM workflow_publication p
			LEFT JOIN workflow_publisher_status ps ON ps.user_id = p.user_id
			WHERE p.snapshot_id = ${plan.source.snapshot_id}
				AND p.owner_state = 'published' AND p.host_state = 'active'
				AND (ps.suspended IS NULL OR ps.suspended = 0)
				AND p.document_digest = ${plan.source.document_digest}
				AND p.bytes_sha256 = ${plan.source.bytes_sha256}
				AND p.status_version = ${plan.source.snapshot_status_version}
				AND COALESCE(ps.status_version, 0) = ${plan.source.publisher_status_version}
		)`
		: sql<boolean>`1`;
	const guard = {
		predicate: sql<boolean>`EXISTS (SELECT 1 FROM library_install WHERE id=${plan.id} AND user_id=${actor.userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce})`
	};
	return [
		sql`INSERT INTO library_install (id,user_id,actor_key,document_digest,plan_digest,request_digest,execution_nonce,receipt_json,created_at)
   SELECT ${plan.id},${actor.userId},${plan.actor_key},${plan.document_digest},${plan.plan_digest},${requestDigest},${executionNonce},${JSON.stringify(receipt)},${receipt.committed_at}
	   WHERE ${packageDestinationExpression(actor.userId, plan.selection)}=${witnessRaw}
	    AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < ${plan.expires_at}
	    AND ${sourceGuard}`.compile(db),
		...compilePackageObjects(db, actor, resolved, plan.allocation, guard, receipt.committed_at),
		sql`SELECT receipt_json FROM library_install WHERE id=${plan.id} AND user_id=${actor.userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce}`.compile(
			db
		)
	];
}
