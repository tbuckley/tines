export interface TransferReviewIdentity {
	open: boolean;
	issueId: string;
	destinationId: string;
}

export interface TransferReviewOwner {
	readonly issueId: string;
	readonly destinationId: string;
	readonly sessionGeneration: number;
	readonly requestGeneration: number;
}

interface TransferReviewCallbacks<T> {
	issueId: string;
	destinationId: string;
	current: () => TransferReviewIdentity;
	transport: () => Promise<T>;
	onSuccess: (value: T, owner: TransferReviewOwner) => void | Promise<void>;
	onFailure: (error: unknown, owner: TransferReviewOwner) => void | Promise<void>;
	onFinally: (owner: TransferReviewOwner) => void | Promise<void>;
}

/**
 * Owns discardable transfer-preview work. A dialog session and each request
 * within it have separate generations so reopening cannot revive an abandoned
 * response, even when the issue and destination happen to be the same.
 *
 * Confirmed transfer POSTs deliberately do not pass through this controller:
 * their result belongs to the issue page, not to the dialog that started them.
 */
export class TransferReviewController {
	#sessionGeneration = 0;
	#requestGeneration = 0;
	#activeIssueId: string | null = null;

	open(issueId: string) {
		this.#sessionGeneration++;
		this.#requestGeneration = 0;
		this.#activeIssueId = issueId;
	}

	invalidate() {
		this.#sessionGeneration++;
		this.#requestGeneration++;
		this.#activeIssueId = null;
	}

	supersedeRequest() {
		this.#requestGeneration++;
	}

	isCurrent(owner: TransferReviewOwner, current: TransferReviewIdentity): boolean {
		return (
			current.open &&
			this.#activeIssueId === owner.issueId &&
			current.issueId === owner.issueId &&
			current.destinationId === owner.destinationId &&
			this.#sessionGeneration === owner.sessionGeneration &&
			this.#requestGeneration === owner.requestGeneration
		);
	}

	async review<T>({
		issueId,
		destinationId,
		current,
		transport,
		onSuccess,
		onFailure,
		onFinally
	}: TransferReviewCallbacks<T>): Promise<void> {
		const owner = Object.freeze({
			issueId,
			destinationId,
			sessionGeneration: this.#sessionGeneration,
			requestGeneration: ++this.#requestGeneration
		});

		try {
			const value = await transport();
			if (this.isCurrent(owner, current())) await onSuccess(value, owner);
		} catch (error) {
			if (this.isCurrent(owner, current())) await onFailure(error, owner);
		} finally {
			if (this.isCurrent(owner, current())) await onFinally(owner);
		}
	}
}
