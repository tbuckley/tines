import {
	parseLibraryV3Document,
	canonicalizeLibraryValue,
	LibraryValidationError,
	publicationBytesSha256,
	type WorkflowPackageDocument,
	type PrepareWorkflowPackageResponse,
	type PackageOperation,
	type HostedPublicationBinding
} from '@tines/shared';
import type { Kysely } from 'kysely';
import { newId, type Database } from '$lib/server/db';
import { sha256Hex } from '$lib/server/crypto';
import { ApiFail, type ActorContext } from '../api/core';
import { readPackageDestination, selectPackageDestination } from './destination';
import { allocatePackageObjects, resolvePackageDestination, type ResolvedPackage } from './resolve';
import { validatePackageBatch } from './budgets';
import { compilePackageInstall, packageReceipt } from './install-queries';
import {
	PACKAGE_COMPILER_VERSION,
	HOSTED_PACKAGE_COMPILER_VERSION,
	PACKAGE_PLAN_TTL_MS,
	packageActorKey,
	packageKeyMaterial,
	signPackagePlan,
	validatePackageAllocation,
	type PackagePlanPayload
} from './token';

async function requireWorkflowDocument(raw: string): Promise<WorkflowPackageDocument> {
	try {
		const document = await parseLibraryV3Document(raw);
		if (document.profile !== 'workflow')
			throw new ApiFail(422, 'wrong_profile', 'Use whole-library import for library-profile files');
		return document;
	} catch (error) {
		if (error instanceof LibraryValidationError)
			throw new ApiFail(422, 'invalid_library', error.message, { diagnostics: error.diagnostics });
		throw error;
	}
}
export async function packagePlanDigest(
	payload: Omit<PackagePlanPayload, 'plan_digest'>,
	resolved: ResolvedPackage
): Promise<string> {
	return `sha256:${await sha256Hex(canonicalizeLibraryValue({ plan: payload, resolved }))}`;
}
export async function packageRequestDigest(payload: PackagePlanPayload): Promise<string> {
	return await sha256Hex(
		canonicalizeLibraryValue({ plan: payload, document_digest: payload.document_digest })
	);
}

/** Complete read-only preparation. The install endpoint is a separate authority boundary. */
export async function prepareWorkflowPackage(
	db: Kysely<Database>,
	env: Pick<Env, 'SECRET_ENCRYPTION_KEY' | 'BETTER_AUTH_SECRET'>,
	actor: ActorContext,
	documentJson: string,
	choices: unknown = {},
	source?: HostedPublicationBinding
): Promise<PrepareWorkflowPackageResponse> {
	const material = packageKeyMaterial(env);
	const document = await requireWorkflowDocument(documentJson);
	if (
		source &&
		(source.document_digest !== document.digest ||
			source.bytes_sha256 !== (await publicationBytesSha256(canonicalizeLibraryValue(document))))
	)
		throw new ApiFail(409, 'publication_changed', 'The hosted publication changed; reload it');
	const allocation = allocatePackageObjects(document);
	const issuedAt = Date.now();
	for (let attempt = 0; attempt < 3; attempt++) {
		const initial = await readPackageDestination(db, actor.userId);
		const resolved = resolvePackageDestination(
			document,
			choices,
			initial.data,
			allocation,
			issuedAt
		);
		const witness = await readPackageDestination(db, actor.userId, resolved.selection);
		if (
			canonicalizeLibraryValue(witness.data) !==
			canonicalizeLibraryValue(selectPackageDestination(initial.data, resolved.selection))
		)
			continue;
		const base: Omit<PackagePlanPayload, 'plan_digest' | 'budget'> = {
			version: 1,
			compiler_version: source ? HOSTED_PACKAGE_COMPILER_VERSION : PACKAGE_COMPILER_VERSION,
			id: newId('lin'),
			user_id: actor.userId,
			actor_key: packageActorKey(actor),
			issued_at: issuedAt,
			expires_at: issuedAt + PACKAGE_PLAN_TTL_MS,
			document_digest: document.digest,
			choices: resolved.choices,
			allocation,
			selection: resolved.selection,
			witness_hash: await sha256Hex(witness.raw),
			...(source ? { source } : {})
		};
		const emptyBudget = { statements: 0, max_parameters: 0, max_sql_bytes: 0, max_value_bytes: 0 };
		const provisional: PackagePlanPayload = {
			...base,
			budget: emptyBudget,
			plan_digest: `sha256:${'0'.repeat(64)}`
		};
		const provisionalReceipt = packageReceipt(
			provisional,
			resolved,
			document.main_workflow_id,
			issuedAt
		);
		const provisionalQueries = compilePackageInstall(
			db,
			actor,
			provisional,
			resolved,
			witness.raw,
			await packageRequestDigest(provisional),
			newId('exe'),
			provisionalReceipt
		);
		const budget = validatePackageBatch(provisionalQueries);
		const unsigned: Omit<PackagePlanPayload, 'plan_digest'> = { ...base, budget };
		const payload: PackagePlanPayload = {
			...unsigned,
			plan_digest: await packagePlanDigest(unsigned, resolved)
		};
		const receipt = packageReceipt(payload, resolved, document.main_workflow_id, issuedAt);
		validatePackageBatch(
			compilePackageInstall(
				db,
				actor,
				payload,
				resolved,
				witness.raw,
				await packageRequestDigest(payload),
				newId('exe'),
				receipt
			)
		);
		const operations: PackageOperation[] = receipt.objects.map((object) => ({
			...object,
			action: 'create'
		}));
		for (const input of resolved.inputs)
			if (input.mode === 'reuse')
				operations.push({
					action: 'reuse',
					kind: input.type,
					local_id: input.input_id,
					id: input.id,
					name: input.value,
					href:
						input.type === 'workflow'
							? `/workflows/${input.id}`
							: input.type === 'project'
								? `/projects/${input.id}`
								: '/labels'
				});
		for (const skip of resolved.skipped)
			operations.push({
				action: 'skip',
				kind: skip.kind,
				local_id: skip.local_id,
				id: null,
				name:
					skip.kind === 'schedule'
						? document.schedules.find((s) => s.id === skip.local_id)!.name
						: document.routing.find((r) => r.id === skip.local_id)!.tier,
				href: null
			});

		return {
			operations,
			document,
			resolved,
			allocation,
			plan_id: payload.id,
			plan_digest: payload.plan_digest,
			document_digest: document.digest,
			issued_at: issuedAt,
			expires_at: payload.expires_at,
			actor_key: payload.actor_key,
			compiler_version: payload.compiler_version,
			budget,
			...(source ? { source } : {}),
			plan_token: await signPackagePlan(payload, material)
		};
	}
	throw new ApiFail(
		409,
		'destination_unstable',
		'The destination changed during preparation; try again'
	);
}

/** Replay signed choices and allocation exactly. Never silently refresh a stale plan. */
export async function reconstructPackagePlan(
	db: Kysely<Database>,
	actor: ActorContext,
	documentJson: string,
	payload: PackagePlanPayload
) {
	if (payload.user_id !== actor.userId || payload.actor_key !== packageActorKey(actor))
		throw new ApiFail(
			403,
			'plan_actor_mismatch',
			'Prepare this package again as the installing actor'
		);
	const document = await requireWorkflowDocument(documentJson);
	if (document.digest !== payload.document_digest)
		throw new ApiFail(409, 'package_changed', 'The package changed after preparation');
	validatePackageAllocation(document, payload.allocation);
	const expectedCompiler = payload.source
		? HOSTED_PACKAGE_COMPILER_VERSION
		: PACKAGE_COMPILER_VERSION;
	if (payload.compiler_version !== expectedCompiler || payload.expires_at <= Date.now())
		throw new ApiFail(
			409,
			'plan_stale',
			'The package plan expired or its compiler changed; prepare again'
		);
	const witness = await readPackageDestination(db, actor.userId, payload.selection);
	if ((await sha256Hex(witness.raw)) !== payload.witness_hash)
		throw new ApiFail(409, 'plan_stale', 'The reviewed destination changed; prepare again');
	const resolved = resolvePackageDestination(
		document,
		payload.choices,
		witness.data,
		payload.allocation,
		payload.issued_at
	);
	const { plan_digest, ...unsigned } = payload;
	if ((await packagePlanDigest(unsigned, resolved)) !== plan_digest)
		throw new ApiFail(409, 'plan_stale', 'The resolved package plan changed; prepare again');
	return { document, resolved, witnessRaw: witness.raw };
}
