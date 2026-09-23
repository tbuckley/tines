import {
	LibraryValidationError,
	parseLibraryV3MutationDocument,
	type WorkflowPackageInstallRequest,
	type WorkflowPackageReceipt
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { ApiFail, runAtomic, runKeyForbidden, type ActorContext } from '../api/core';
import { validatePackageBatch } from './budgets';
import { compilePackageInstall, packageReceipt } from './install-queries';
import { packageRequestDigest, reconstructPackagePlan } from './plan';
import {
	packageActorKey,
	packageKeyMaterial,
	verifyPackagePlan,
	type PackagePlanPayload
} from './token';

interface StoredReceipt {
	actor_key: string;
	document_digest: string;
	plan_digest: string;
	request_digest: string;
	receipt_json: string;
}

async function receiptRow(db: Kysely<Database>, userId: string, planId: string) {
	return db
		.selectFrom('library_install')
		.select(['actor_key', 'document_digest', 'plan_digest', 'request_digest', 'receipt_json'])
		.where('id', '=', planId)
		.where('user_id', '=', userId)
		.executeTakeFirst() as Promise<StoredReceipt | undefined>;
}

function parseReceipt(raw: string): WorkflowPackageReceipt {
	return JSON.parse(raw) as WorkflowPackageReceipt;
}

function assertMatchingReceipt(
	row: StoredReceipt,
	payload: PackagePlanPayload,
	actorKey: string,
	requestDigest: string
) {
	if (
		row.actor_key !== actorKey ||
		row.document_digest !== payload.document_digest ||
		row.plan_digest !== payload.plan_digest ||
		row.request_digest !== requestDigest
	)
		throw new ApiFail(
			409,
			'install_request_mismatch',
			'This plan ID was committed by a different request'
		);
}

async function assertDocumentDigest(documentJson: string, expected: string) {
	try {
		const document = await parseLibraryV3MutationDocument(documentJson);
		if (document.profile !== 'workflow')
			throw new ApiFail(422, 'wrong_profile', 'Use whole-library import for library-profile files');
		if (document.digest !== expected)
			throw new ApiFail(409, 'package_changed', 'The package changed after preparation');
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(422, 'invalid_library', error.message, { diagnostics: error.diagnostics });
		throw error;
	}
}

/** Commit exactly one signed preparation, or recover its immutable receipt. */
export async function installWorkflowPackage(
	db: Kysely<Database>,
	env: Env,
	actor: ActorContext,
	request: WorkflowPackageInstallRequest,
	beforeAtomic?: (source: PackagePlanPayload['source']) => Promise<void>
): Promise<WorkflowPackageReceipt> {
	if (actor.agentRunId) throw runKeyForbidden({ path: '/api/v1/library/install' });
	const payload = await verifyPackagePlan(request.plan_token, packageKeyMaterial(env));
	const actorKey = packageActorKey(actor);
	if (payload.user_id !== actor.userId || payload.actor_key !== actorKey)
		throw new ApiFail(
			403,
			'plan_actor_mismatch',
			'Prepare this package again as the installing actor'
		);
	if (request.confirmation.plan_digest !== payload.plan_digest)
		throw new ApiFail(409, 'confirmation_mismatch', 'Confirm the exact prepared plan digest');
	const requestDigest = await packageRequestDigest(payload);

	const prior = await receiptRow(db, actor.userId, payload.id);
	if (prior) {
		assertMatchingReceipt(prior, payload, actorKey, requestDigest);
		return parseReceipt(prior.receipt_json);
	}
	await assertDocumentDigest(request.document_json, payload.document_digest);

	const { document, resolved, witnessRaw } = await reconstructPackagePlan(
		db,
		actor,
		request.document_json,
		payload
	);
	const now = Date.now();
	const executionNonce = newId('exe');
	const receipt = packageReceipt(payload, resolved, document.main_workflow_id, now);
	const queries = compilePackageInstall(
		db,
		actor,
		payload,
		resolved,
		witnessRaw,
		requestDigest,
		executionNonce,
		receipt
	);
	validatePackageBatch(queries);
	await beforeAtomic?.(payload.source);
	try {
		const results = await runAtomic(env, queries);
		const selected = results.at(-1)?.results?.[0] as { receipt_json?: unknown } | undefined;
		if (typeof selected?.receipt_json !== 'string')
			throw new ApiFail(409, 'plan_stale', 'The reviewed destination changed or the plan expired');
		return parseReceipt(selected.receipt_json);
	} catch (error) {
		if (error instanceof ApiFail) throw error;
		let committed: StoredReceipt | undefined;
		try {
			committed = await receiptRow(db, actor.userId, payload.id);
		} catch {
			throw new ApiFail(
				503,
				'install_outcome_unknown',
				'Installation outcome is unknown; retry this same signed plan or check its receipt'
			);
		}
		if (committed) {
			assertMatchingReceipt(committed, payload, actorKey, requestDigest);
			return parseReceipt(committed.receipt_json);
		}
		const message = error instanceof Error ? error.message : '';
		if (/constraint|SQLITE|D1_ERROR/i.test(message)) throw error;
		throw new ApiFail(
			503,
			'install_outcome_unknown',
			'Installation outcome is unknown; retry this same signed plan or check its receipt'
		);
	}
}

/** Owner-scoped recovery deliberately ignores the API key that created the receipt. */
export async function getWorkflowPackageReceipt(
	db: Kysely<Database>,
	actor: ActorContext,
	planId: string
): Promise<WorkflowPackageReceipt> {
	const row = await receiptRow(db, actor.userId, planId);
	if (!row) throw new ApiFail(404, 'not_found', 'Install receipt not found');
	return parseReceipt(row.receipt_json);
}
