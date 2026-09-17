import { json } from '@sveltejs/kit';
import type { PublishPublicationRequest } from '@tines/shared';
import { api, apiContext, ApiFail, readJson, requireJsonObject } from '$lib/server/api/core';
import { publishPublication } from '$lib/server/publications/publish';
import { runE2ePublicationRaceMutation } from '$lib/server/publications/e2e-race';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = api(async (event) => {
	const { db, env, actor } = await apiContext(event);
	const body = requireJsonObject(await readJson<unknown>(event));
	if (
		Object.keys(body).some(
			(key) =>
				!['review_digest', 'sharing_rights', 'exact_content', 'reviewed_repo_ids'].includes(key)
		) ||
		typeof body.review_digest !== 'string' ||
		body.sharing_rights !== true ||
		body.exact_content !== true ||
		!Array.isArray(body.reviewed_repo_ids) ||
		!body.reviewed_repo_ids.every((value) => typeof value === 'string' && value.length <= 100)
	)
		throw new ApiFail(422, 'invalid_field', 'Expected the exact publication confirmation');
	// Compiled out of normal builds. The native-D1 race must mutate after the
	// service reads but before DB.batch() to prove the transaction predicate.
	const e2ePrecommitWorkflow =
		import.meta.env.VITE_TINES_E2E === '1'
			? event.request.headers.get('x-tines-e2e-publication-precommit-workflow')
			: null;
	return json(
		await publishPublication(
			db,
			env,
			actor,
			event.params.candidateId,
			body as unknown as PublishPublicationRequest,
			undefined,
			async () => {
				await runE2ePublicationRaceMutation(event.request, env, {
					publicationId: event.params.candidateId
				});
				if (e2ePrecommitWorkflow) {
					const changed = await db
						.updateTable('workflow')
						.set({ description: `native precommit mutation ${event.params.candidateId}` })
						.where('id', '=', e2ePrecommitWorkflow)
						.where('user_id', '=', actor.userId)
						.executeTakeFirst();
					if (Number(changed.numUpdatedRows) !== 1)
						throw new Error('E2E precommit source mutation did not update one workflow');
				}
			}
		)
	);
});
