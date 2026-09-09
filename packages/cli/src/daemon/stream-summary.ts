import type { AgentRunUsage } from '@tines/shared';

export interface StreamSummary {
	providerSessionId?: string;
	usage?: AgentRunUsage;
	numTurns?: number;
	durationMs?: number;
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
	return { ...value, ...(value.usage ? { usage: { ...value.usage } } : {}) };
}
