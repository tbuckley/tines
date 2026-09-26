/**
 * Guarded launch material for runs in a shared project (Tines/752).
 *
 * The material — the shared bundle, the env channel and the rendered prompts
 * — is built before the run key exists, and the key is minted only if the
 * bundle's witness still holds (`mintRunKeyAndFlip`'s `guard`). A lost guard
 * rebuilds once; a second loss, a cap or a checkout-dir conflict releases the
 * assigned run without a strike and holds the issue back in
 * `issue_guidance_block` so the claim loop does not spin on it.
 */
import type { SharedExecutionBundleV1 } from '@tines/shared';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db';
import {
	buildLaunchPrompt,
	buildResumePrompt,
	resolvedEnvForIssue,
	type ResolvedEnvEntry
} from '../api/context';
import { ApiFail } from '../api/core';
import {
	BUNDLE_ATTEMPTS,
	bundleFailure,
	bundleWitnessExpr,
	issueSharedProject,
	loadSharedExecutionBundle,
	type BundleFailureReason,
	type BundleWitness
} from '../api/shared-execution-bundle';
import { sharedExecutionEnabled } from '../api/shared-execution';
import { endRun, loadEndableRun, mintRunKeyAndFlip } from './engine';

/** Backoff after a churn exhaustion: guidance is moving, try again soon. */
export const GUIDANCE_CHURN_BACKOFF_MS = 30_000;
/** Backoff after a cap or conflict: the owner has to fix something. */
export const GUIDANCE_REFUSAL_BACKOFF_MS = 10 * 60_000;

/** Server-only: never serialized as a whole to any client or daemon. */
export interface LaunchMaterialV1 {
	bundle: SharedExecutionBundleV1;
	witness: BundleWitness;
	/** Values ride beside the bundle, never inside it. */
	env: ResolvedEnvEntry[];
	launchPrompt: string;
	resumePrompt: string;
}

type AdmitRun = Pick<Database['agent_run'], 'id' | 'user_id' | 'issue_id' | 'state_id_at_start'>;

/** True when this run takes the shared path: flag on and a shared project. */
export async function usesSharedLaunch(
	env: Env,
	db: Kysely<Database>,
	issueId: string
): Promise<boolean> {
	if (!sharedExecutionEnabled(env)) return false;
	return (await issueSharedProject(db, issueId))?.shared === true;
}

/**
 * Builds the launch material for a run. Unvalidated on purpose: the caller
 * guards the mint on `witness` instead. Throws the bundle's ApiFail on a cap
 * or conflict, and whatever env resolution throws.
 */
export async function prepareLaunchMaterial(
	env: Env,
	db: Kysely<Database>,
	run: AdmitRun,
	opts: { envChannel: boolean }
): Promise<LaunchMaterialV1> {
	const { bundle, witness } = await loadSharedExecutionBundle(env, db, {
		issueId: run.issue_id,
		launchStateId: run.state_id_at_start,
		skillFiles: true,
		validate: false
	});
	const resolvedEnv = opts.envChannel
		? await resolvedEnvForIssue(db, env, run.user_id, run.issue_id)
		: [];
	const { guidance, issue } = bundle;
	return {
		bundle,
		witness,
		env: resolvedEnv,
		launchPrompt: buildLaunchPrompt(
			guidance,
			issue.detail,
			issue.artifacts,
			issue.label_vocabulary
		),
		resumePrompt: buildResumePrompt(guidance, issue.detail, issue.artifacts, issue.label_vocabulary)
	};
}

export type SharedAdmission =
	| { kind: 'admitted'; keyId: string; secret: string; material: LaunchMaterialV1 }
	/** Another poll won the flip, or the run was ended: stand down. */
	| { kind: 'lost' }
	/** Released without a strike; the issue is held back until `retry_after`. */
	| { kind: 'released'; error: string };

/**
 * Material first, then the guarded mint, rebuilding once when the witness
 * moved underneath it. `beforeMint` is a test hook (the native-D1 race).
 */
export async function admitSharedRun(
	env: Env,
	db: Kysely<Database>,
	run: AdmitRun,
	input: {
		maxRunMinutes: number;
		now: number;
		envChannel: boolean;
		localAdmission?: { runnerId: string; instanceId: string; ceiling: number };
		beforeMint?: (attempt: number) => Promise<void>;
	}
): Promise<SharedAdmission> {
	let failure: { reason: BundleFailureReason; error: string } | null = null;
	for (let attempt = 1; attempt <= BUNDLE_ATTEMPTS; attempt++) {
		let material: LaunchMaterialV1;
		try {
			material = await prepareLaunchMaterial(env, db, run, { envChannel: input.envChannel });
		} catch (e) {
			const reason = e instanceof ApiFail ? (e.details?.reason as BundleFailureReason) : undefined;
			if (reason) {
				failure = { reason, error: `guidance bundle unavailable: ${reason}` };
				break;
			}
			// Env decrypt (or any other preparation) failure: no key exists yet,
			// so releasing the claim is the whole cleanup.
			const error = e instanceof Error ? e.message : String(e);
			await releaseAssigned(env, db, run, error, input.now);
			return { kind: 'released', error };
		}
		await input.beforeMint?.(attempt);
		const minted = await mintRunKeyAndFlip(db, env, {
			runId: run.id,
			userId: run.user_id,
			maxRunMinutes: input.maxRunMinutes,
			now: input.now,
			localAdmission: input.localAdmission,
			guard: sql<boolean>`${bundleWitnessExpr(db, material.witness)} = ${material.witness.vector}`
		});
		if (minted) {
			await db.deleteFrom('issue_guidance_block').where('issue_id', '=', run.issue_id).execute();
			return { kind: 'admitted', ...minted, material };
		}
		const live = await db
			.selectNoFrom(bundleWitnessExpr(db, material.witness).as('vector'))
			.executeTakeFirst();
		// Unchanged witness: the flip lost for today's reasons.
		if (live?.vector === material.witness.vector) return { kind: 'lost' };
		failure = { reason: 'churn', error: 'guidance bundle unavailable: churn' };
	}
	const { reason, error } = failure ?? { reason: 'churn', error: 'guidance bundle unavailable' };
	const released = await releaseAssigned(env, db, run, error, input.now);
	if (!released) return { kind: 'lost' };
	const failed = bundleFailure(reason);
	await db
		.insertInto('issue_guidance_block')
		.values({
			issue_id: run.issue_id,
			code: failed.code as 'bundle_too_large' | 'bundle_unavailable',
			reason,
			retry_after:
				input.now + (reason === 'churn' ? GUIDANCE_CHURN_BACKOFF_MS : GUIDANCE_REFUSAL_BACKOFF_MS),
			created_at: input.now
		})
		.onConflict((oc) =>
			oc.column('issue_id').doUpdateSet((eb) => ({
				code: eb.ref('excluded.code'),
				reason: eb.ref('excluded.reason'),
				retry_after: eb.ref('excluded.retry_after'),
				created_at: eb.ref('excluded.created_at')
			}))
		)
		.execute();
	return { kind: 'released', error };
}

/** The no-strike cancel the delivery eligibility re-check uses. */
async function releaseAssigned(
	env: Env,
	db: Kysely<Database>,
	run: AdmitRun,
	error: string,
	now: number
): Promise<boolean> {
	const endable = await loadEndableRun(db, run.user_id, run.id);
	if (!endable || endable.status !== 'assigned') return false;
	const ended = await endRun(db, env, endable, { status: 'canceled', error, now });
	return ended.ended;
}
