import type {
	PreparePublicationRequest,
	PublicationProof,
	PublishPublicationRequest
} from '@tines/shared';

type PrepareBody = Omit<PreparePublicationRequest, 'prepare_request_id'>;

export class PublicationFlowController {
	revision = 0;
	proof: PublicationProof | null = null;
	reviewedIds = new Set<string>();
	consented = false;
	private attempt: { revision: number; key: string; request: PreparePublicationRequest } | null =
		null;

	invalidate() {
		this.revision += 1;
		this.proof = null;
		this.reviewedIds = new Set();
		this.consented = false;
		this.attempt = null;
	}

	prepareRequest(body: PrepareBody, createId: () => string = () => crypto.randomUUID()) {
		const detached = structuredClone(body);
		const key = JSON.stringify(detached);
		if (this.attempt?.revision === this.revision && this.attempt.key === key)
			return this.attempt.request;
		const request = { ...detached, prepare_request_id: createId() };
		this.attempt = { revision: this.revision, key, request };
		return request;
	}

	acceptProof(proof: PublicationProof, revision: number, now = Date.now()) {
		if (revision !== this.revision) return false;
		if (proof.expires_at <= now) {
			this.invalidate();
			return false;
		}
		this.proof = proof;
		this.reviewedIds = new Set();
		this.consented = false;
		return true;
	}

	canReuseProof(now = Date.now()) {
		return Boolean(this.proof && this.proof.expires_at > now);
	}

	reviewIncluded() {
		if (!this.proof) return;
		this.reviewedIds = new Set(
			this.proof.document.context
				.filter((item) => item.kind === 'skill' || item.kind === 'repo')
				.map((item) => item.id)
		);
		this.consented = false;
	}

	setConsent(value: boolean) {
		this.consented = value;
	}

	publishRequest(): PublishPublicationRequest | null {
		if (!this.proof || !this.consented) return null;
		const dependencies = this.proof.document.context.filter(
			(item) => item.kind === 'skill' || item.kind === 'repo'
		);
		if (!dependencies.every((item) => this.reviewedIds.has(item.id))) return null;
		return {
			review_digest: this.proof.review_digest,
			sharing_rights: true,
			exact_content: true,
			reviewed_repo_ids: this.proof.document.context
				.filter((item) => item.kind === 'repo' && this.reviewedIds.has(item.id))
				.map((item) => item.id)
		};
	}
}
