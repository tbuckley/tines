import { sql, type Kysely, type CompiledQuery } from 'kysely';
import type { Database } from '$lib/server/db';
import type { ActorContext } from '../api/core';
import { packageDestinationExpression } from './destination';
import { compilePackageObjects } from './compile';
import type { ResolvedPackage } from './resolve';
import type { PackagePlanPayload } from './token';

export interface PackageReceipt {
	id: string;
	document_digest: string;
	plan_digest: string;
	committed_at: number;
	objects: {
		kind: string;
		local_id: string;
		id: string;
		name: string;
		href: string;
		relationship?: 'main' | 'dependency';
	}[];
	reused_inputs: { input_id: string; type: string; id: string; name: string }[];
}
export function packageReceipt(
	plan: PackagePlanPayload,
	resolved: ResolvedPackage,
	mainId: string,
	now: number
): PackageReceipt {
	const objects: PackageReceipt['objects'] = [];
	for (const w of resolved.workflows)
		objects.push({
			kind: 'workflow',
			local_id: w.id,
			id: plan.allocation.records[w.id].id,
			name: w.name,
			href: `/workflows/${plan.allocation.records[w.id].id}`,
			relationship: w.id === mainId ? 'main' : 'dependency'
		});
	for (const c of resolved.context)
		objects.push({
			kind: c.kind,
			local_id: c.id,
			id: plan.allocation.records[c.id].id,
			name: c.name,
			href: `/context?workflow=${plan.allocation.records[resolved.workflows.find((w) => w.states.some((s) => s.id === c.state_id))!.id].id}&q=${encodeURIComponent(c.name)}`
		});
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
			.map((i) => ({ input_id: i.input_id, type: i.type, id: i.id!, name: i.value }))
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
	receipt: PackageReceipt
): CompiledQuery[] {
	const guard = {
		predicate: sql<boolean>`EXISTS (SELECT 1 FROM library_install WHERE id=${plan.id} AND user_id=${actor.userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce})`
	};
	return [
		sql`INSERT INTO library_install (id,user_id,actor_key,document_digest,plan_digest,request_digest,execution_nonce,receipt_json,created_at)
   SELECT ${plan.id},${actor.userId},${plan.actor_key},${plan.document_digest},${plan.plan_digest},${requestDigest},${executionNonce},${JSON.stringify(receipt)},${receipt.committed_at}
   WHERE ${packageDestinationExpression(actor.userId, plan.selection)}=${witnessRaw}
    AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) < ${plan.expires_at}`.compile(
			db
		),
		...compilePackageObjects(db, actor, resolved, plan.allocation, guard, receipt.committed_at),
		sql`SELECT receipt_json FROM library_install WHERE id=${plan.id} AND user_id=${actor.userId} AND request_digest=${requestDigest} AND execution_nonce=${executionNonce}`.compile(
			db
		)
	];
}
