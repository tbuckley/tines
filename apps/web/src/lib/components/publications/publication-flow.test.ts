import { describe, expect, it } from 'vitest';
import type { PublicationProof } from '@tines/shared';
import { PublicationFlowController } from './publication-flow';

const body = {
	source: { kind: 'owned_workflow' as const, workflow_id: 'wf_1', options: {} },
	metadata: { display_name: 'Ada', license: 'MIT' as const, license_year: 2026 }
};

function proof(expiresAt = Date.now() + 1000) {
	return {
		candidate_id: 'candidate_1',
		expires_at: expiresAt,
		byte_length: 10,
		metadata: body.metadata,
		document_digest: 'document',
		bytes_sha256: 'bytes',
		review_digest: 'review',
		document: {
			profile: 'workflow',
			format: 'tines-library',
			version: 3,
			digest: 'document',
			exported_at: 0,
			main_workflow_id: 'wf_1',
			workflows: [],
			context: [
				{
					id: 'repo_1',
					kind: 'repo',
					state_id: 'state_1',
					name: 'Repo',
					description: '',
					repo_url: 'https://example.com'
				}
			],
			inputs: [],
			text_uses: [],
			schedules: [],
			routing: []
		}
	} as unknown as PublicationProof;
}

describe('PublicationFlowController', () => {
	it('reuses an immutable preparation request until content changes', () => {
		const flow = new PublicationFlowController();
		const first = flow.prepareRequest(body, () => 'request_1');
		body.metadata.display_name = 'Changed after capture';
		expect(first.metadata.display_name).toBe('Ada');
		body.metadata.display_name = 'Ada';
		expect(flow.prepareRequest(body, () => 'request_2')).toBe(first);
		flow.invalidate();
		expect(flow.prepareRequest(body, () => 'request_2').prepare_request_id).toBe('request_2');
	});

	it('ignores a proof returned after the draft revision changes', () => {
		const flow = new PublicationFlowController();
		const revision = flow.revision;
		flow.invalidate();
		expect(flow.acceptProof(proof(), revision)).toBe(false);
		expect(flow.proof).toBeNull();
	});

	it('binds aggregate review and consent to the active proof', () => {
		const flow = new PublicationFlowController();
		expect(flow.acceptProof(proof(), 0)).toBe(true);
		flow.reviewIncluded();
		flow.setConsent(true);
		expect(flow.publishRequest()).toEqual({
			review_digest: 'review',
			sharing_rights: true,
			exact_content: true,
			reviewed_repo_ids: ['repo_1']
		});
		flow.invalidate();
		expect(flow.publishRequest()).toBeNull();
	});

	it('does not reuse an expired proof', () => {
		const flow = new PublicationFlowController();
		flow.acceptProof(proof(100), 0);
		expect(flow.canReuseProof(101)).toBe(false);
		flow.invalidate();
		expect(flow.prepareRequest(body, () => 'request_after_expiry').prepare_request_id).toBe(
			'request_after_expiry'
		);
	});
});
