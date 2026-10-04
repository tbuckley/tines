import type { AgentRunUsage, CodexPricingEvidenceV1 } from '@tines/shared';

/**
 * The stream's account of how the harness ended: the provider refused on a
 * usage limit, the provider failed, or the harness itself gave up. It is read
 * on any non-zero exit, and on exit 0 for `pi` alone, whose exit code cannot
 * be trusted to say (it exits 0 when the model call failed). `detail` is the
 * provider's or the harness's message, unredacted.
 */
export type HarnessOutcome =
	| { kind: 'ok' }
	| {
			kind: 'rate_limited';
			detail: string;
			/** Epoch ms the provider said the window reopens, when it said. */
			resumeAt?: number;
	  }
	| { kind: 'provider_error' | 'error'; detail: string };

export interface StreamSummary {
	providerSessionId?: string;
	usage?: AgentRunUsage;
	numTurns?: number;
	durationMs?: number;
	pricingEvidence?: CodexPricingEvidenceV1;
	/** Set by a renderer whose stream says the provider refused or failed. */
	harnessOutcome?: HarnessOutcome;
	/** The effort the harness recorded actually applying, when it says. */
	appliedEffort?: string;
}

export interface RunStreamRenderer {
	write(chunk: string): void;
	finish(): void;
	summary(): StreamSummary;
}

export function validMetric(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validProviderSessionId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 1 &&
		value.length <= 255 &&
		Boolean(value.trim()) &&
		!/[\x00-\x1f\x7f]/.test(value)
	);
}

export function copySummary(value: StreamSummary): StreamSummary {
	return {
		...value,
		...(value.usage ? { usage: { ...value.usage } } : {}),
		...(value.harnessOutcome ? { harnessOutcome: { ...value.harnessOutcome } } : {}),
		...(value.pricingEvidence
			? {
					pricingEvidence: {
						...value.pricingEvidence,
						...(value.pricingEvidence.raw_usage
							? { raw_usage: { ...value.pricingEvidence.raw_usage } }
							: {}),
						...(value.pricingEvidence.request_context
							? {
									request_context: {
										...value.pricingEvidence.request_context,
										...(value.pricingEvidence.request_context.status === 'complete'
											? {
													reconciled_usage: {
														...value.pricingEvidence.request_context.reconciled_usage
													}
												}
											: {})
									}
								}
							: {})
					}
				}
			: {})
	};
}
