import type {
	AgentRunUsage,
	CodexPricingEvidenceV1,
	RunPricingBasisV1,
	RunPricingReason
} from '@tines/shared';
import { isSupportedCodexRolloutVersion } from '@tines/shared';

export interface CodexRate {
	id: string;
	version: number;
	model: string;
	provider: 'openai';
	plan: 'api_standard' | 'user_entered';
	rate_source?: 'user';
	rate_entered_at?: number;
	context_band: 'short' | 'published';
	adopted_at: number;
	source_url: string;
	source_checked_at: string;
	source_effective_at: string | null;
	rates: Record<
		'input_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'output_tokens',
		string | null
	>;
}

export const RATE_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;

const ADOPTED = Date.parse('2026-09-11T03:30:00Z');
const PRICING = 'https://developers.openai.com/api/docs/pricing';

function rate(
	model: string,
	input: string,
	read: string,
	write: string | null,
	output: string,
	context_band: CodexRate['context_band'],
	source_url = `https://developers.openai.com/api/docs/models/${model}`
): CodexRate {
	return {
		id: `openai-api-standard:${model}:2026-09-11:v1`,
		version: 1,
		model,
		provider: 'openai',
		plan: 'api_standard',
		context_band,
		adopted_at: ADOPTED,
		source_url,
		source_checked_at: '2026-09-11',
		source_effective_at: null,
		rates: {
			input_tokens: input,
			cache_read_tokens: read,
			cache_write_tokens: write,
			output_tokens: output
		}
	};
}

export interface UserRateRow {
	id: string;
	model: string;
	version: number;
	input_rate: string;
	cache_read_rate: string;
	cache_write_rate: string | null;
	output_rate: string;
	created_at: number;
}

export function userRateToCodexRate(row: UserRateRow): CodexRate {
	return {
		id: `user-rate:${row.id}`,
		version: row.version,
		model: row.model,
		provider: 'openai',
		plan: 'user_entered',
		rate_source: 'user',
		rate_entered_at: row.created_at,
		context_band: 'published',
		adopted_at: 0,
		source_url: '',
		source_checked_at: new Date(row.created_at).toISOString().slice(0, 10),
		source_effective_at: null,
		rates: {
			input_tokens: row.input_rate,
			cache_read_tokens: row.cache_read_rate,
			cache_write_tokens: row.cache_write_rate,
			output_tokens: row.output_rate
		}
	};
}

/** Append-only: add a version; never edit a rate already adopted. */
export const CODEX_RATES: readonly CodexRate[] = [
	rate('gpt-6-astra', '10', '1', '12.5', '50', 'short', PRICING),
	rate('gpt-5.6-sol', '4', '0.4', '5', '20', 'short', PRICING),
	rate('gpt-5.6-terra', '2', '0.2', '2.5', '12', 'short', PRICING),
	rate('gpt-5.6-luna', '0.2', '0.02', '0.25', '1.2', 'short', PRICING),
	rate('gpt-5-codex', '1.25', '0.125', null, '10', 'published'),
	rate('gpt-5.1-codex', '1.25', '0.125', null, '10', 'published'),
	rate('gpt-5.1-codex-max', '1.25', '0.125', null, '10', 'published'),
	rate('gpt-5.1-codex-mini', '0.25', '0.025', null, '2', 'published'),
	rate('gpt-5.2-codex', '1.75', '0.175', null, '14', 'published'),
	rate('gpt-5.3-codex', '1.75', '0.175', null, '14', 'published'),
	rate('codex-mini-latest', '1.5', '0.375', null, '6', 'published')
];

const CLASSES = [
	'input_tokens',
	'cache_read_tokens',
	'cache_write_tokens',
	'output_tokens'
] as const;
type TokenClass = (typeof CLASSES)[number];
const RAW_CLASSES = [
	'input_tokens',
	'cached_input_tokens',
	'cache_write_input_tokens',
	'output_tokens'
] as const;

function validCompleteRequestContext(evidence: CodexPricingEvidenceV1): boolean {
	const proof = evidence.request_context;
	if (!proof || proof.status !== 'complete') return false;
	if (
		proof.version !== 1 ||
		proof.normalization !== 'codex-rollout-delta-v1' ||
		!isSupportedCodexRolloutVersion(proof.harness_version) ||
		!Number.isSafeInteger(proof.request_count) ||
		proof.request_count < 0 ||
		proof.request_count > 10_000 ||
		!Number.isSafeInteger(proof.max_request_input_tokens) ||
		proof.max_request_input_tokens < 0
	)
		return false;
	const values = RAW_CLASSES.map((field) => proof.reconciled_usage[field]);
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) return false;
	const [total, read, write, output] = values;
	if (
		read + write > total ||
		RAW_CLASSES.some((field) => proof.reconciled_usage[field] !== evidence.raw_usage?.[field])
	)
		return false;
	if (proof.request_count === 0)
		return proof.max_request_input_tokens === 0 && values.every((value) => value === 0);
	if (values.some((value) => value > 0) && proof.request_count === 0) return false;
	return (
		proof.max_request_input_tokens <= total &&
		BigInt(total) <= BigInt(proof.request_count) * BigInt(proof.max_request_input_tokens)
	);
}

function unpriced(
	usage: AgentRunUsage,
	evidence: CodexPricingEvidenceV1 | undefined,
	now: number,
	reason: RunPricingReason
): AgentRunUsage {
	const { cost_usd: _cost, ...withoutCost } = usage;
	return {
		...withoutCost,
		cost_source: evidence ? 'priced' : usage.cost_source,
		pricing: {
			version: 1,
			...(evidence ? { evidence } : {}),
			evaluated_at: now,
			status: 'unpriced',
			reason
		}
	};
}

function scaledRate(value: string): bigint | null {
	if (!RATE_PATTERN.test(value)) return null;
	const [whole, fraction = ''] = value.split('.');
	return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function decimal(numerator: bigint): string {
	// rates have 9 decimal places and are per million tokens.
	const denominator = 1_000_000_000_000_000n;
	const whole = numerator / denominator;
	const fraction = (numerator % denominator).toString().padStart(15, '0').replace(/0+$/, '');
	return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function priceCodexUsage(
	input: {
		run: { model: string | null; created_at: number; resumed_from_run_id?: string | null };
		usage: AgentRunUsage;
		evidence?: CodexPricingEvidenceV1;
		now: number;
	},
	catalog: readonly CodexRate[] = CODEX_RATES
): AgentRunUsage {
	const { run, evidence, now } = input;
	const usage = { ...input.usage };
	if (usage.cost_source === 'provider' && usage.cost_usd !== undefined) {
		return evidence
			? {
					...usage,
					pricing: { version: 1, evidence, evaluated_at: now, status: 'provider_authoritative' }
				}
			: usage;
	}
	if (!evidence) {
		if (usage.cost_usd !== undefined) return usage;
		const measured = CLASSES.some((field) => usage[field] !== undefined);
		return measured ? unpriced(usage, undefined, now, 'pricing_evidence_missing') : usage;
	}
	if (evidence.session_mode === 'resumed' || run.resumed_from_run_id)
		return unpriced(usage, evidence, now, 'attempt_scope_unknown');
	const statusReason: Partial<
		Record<CodexPricingEvidenceV1['measurement_status'], RunPricingReason>
	> = {
		missing: 'missing_token_dimension',
		invalid: 'invalid_token_dimension',
		nonmonotonic: 'nonmonotonic_usage',
		incomplete_attempt: 'incomplete_attempt',
		multiple_threads: 'multiple_threads'
	};
	if (evidence.measurement_status !== 'complete')
		return unpriced(
			usage,
			evidence,
			now,
			statusReason[evidence.measurement_status] ?? 'invalid_pricing_evidence'
		);
	if (!run.model || !evidence.model) return unpriced(usage, evidence, now, 'model_missing');
	if (evidence.model !== run.model) return unpriced(usage, evidence, now, 'model_mismatch');
	if (evidence.model_rerouted) return unpriced(usage, evidence, now, 'model_rerouted');
	const raw = evidence.raw_usage;
	if (
		!raw ||
		CLASSES.some(
			(_, i) =>
				raw[
					['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens'][
						i
					] as keyof typeof raw
				] === undefined
		)
	)
		return unpriced(usage, evidence, now, 'missing_token_dimension');
	const values = [
		raw.input_tokens,
		raw.cached_input_tokens,
		raw.cache_write_input_tokens,
		raw.output_tokens
	];
	if (values.some((value) => !Number.isSafeInteger(value) || value! < 0))
		return unpriced(usage, evidence, now, 'invalid_token_dimension');
	const [total, read, write, output] = values as number[];
	if (read + write > total) return unpriced(usage, evidence, now, 'invalid_token_dimension');
	const tokens: Record<TokenClass, number> = {
		input_tokens: total - read - write,
		cache_read_tokens: read,
		cache_write_tokens: write,
		output_tokens: output
	};
	if (CLASSES.some((field) => usage[field] !== tokens[field]))
		return unpriced({ ...usage, ...tokens }, evidence, now, 'invalid_token_dimension');
	const candidates = catalog
		.filter((entry) => entry.model === run.model)
		.sort((a, b) => a.adopted_at - b.adopted_at);
	if (candidates.length === 0)
		return unpriced({ ...usage, ...tokens }, evidence, now, 'unsupported_model');
	const selectedIndex = candidates.findLastIndex((entry) => entry.adopted_at <= run.created_at);
	if (selectedIndex < 0) return unpriced({ ...usage, ...tokens }, evidence, now, 'missing_rate');
	const selected = candidates[selectedIndex]!;
	const requestContext = evidence.request_context;
	if (selected.context_band === 'short' && requestContext) {
		if (
			requestContext.status === 'invalid' ||
			(requestContext.status === 'complete' && !validCompleteRequestContext(evidence))
		)
			return unpriced({ ...usage, ...tokens }, evidence, now, 'request_context_invalid');
		if (requestContext.status === 'complete' && requestContext.max_request_input_tokens > 272_000)
			return unpriced({ ...usage, ...tokens }, evidence, now, 'long_context_rate_unsupported');
	}
	if (
		selected.context_band === 'short' &&
		total > 272_000 &&
		!(requestContext?.status === 'complete' && validCompleteRequestContext(evidence))
	)
		return unpriced({ ...usage, ...tokens }, evidence, now, 'long_context_band_unknown');
	if (selected.rates.cache_write_tokens === null && write !== 0)
		return unpriced({ ...usage, ...tokens }, evidence, now, 'missing_rate');
	let sum = 0n;
	for (const field of CLASSES) {
		const rateValue = selected.rates[field];
		if (rateValue === null) continue;
		const scaled = scaledRate(rateValue);
		if (scaled === null) return unpriced({ ...usage, ...tokens }, evidence, now, 'missing_rate');
		sum += BigInt(tokens[field]) * scaled;
	}
	const exact = decimal(sum);
	const projection = Number(exact);
	if (!Number.isFinite(projection))
		return unpriced({ ...usage, ...tokens }, evidence, now, 'cost_out_of_range');
	const basis: RunPricingBasisV1 = {
		calculation_version: 'tokens-times-usd-per-million-v1',
		provider: 'openai',
		model: run.model,
		model_identity: 'requested_launch_no_observed_reroute',
		usage_scope: 'attempt',
		plan: selected.plan,
		...(selected.plan === 'user_entered'
			? { rate_source: 'user' as const, rate_entered_at: selected.rate_entered_at }
			: {}),
		context_band: selected.context_band,
		rate_id: selected.id,
		rate_version: selected.version,
		rate_adopted_at: selected.adopted_at,
		rate_valid_to: candidates[selectedIndex + 1]?.adopted_at ?? null,
		rate_selected_at: run.created_at,
		source_url: selected.source_url,
		source_checked_at: selected.source_checked_at,
		source_effective_at: selected.source_effective_at,
		unit_tokens: 1_000_000,
		rates: selected.rates,
		cost_usd_exact: exact
	};
	return {
		...usage,
		...tokens,
		cost_usd: projection,
		cost_source: 'priced',
		pricing: { version: 1, evidence, evaluated_at: now, status: 'calculated', basis }
	};
}
