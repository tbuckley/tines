import type { AgentRunUsage, CodexPricingEvidenceV1 } from '@tines/shared';

export interface StreamSummary {
	providerSessionId?: string;
	usage?: AgentRunUsage;
	numTurns?: number;
	durationMs?: number;
	pricingEvidence?: CodexPricingEvidenceV1;
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
