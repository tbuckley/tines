import type { AgentRunUsage, RunPricingBasisV1, RunPricingReason } from './types.js';
import { instantsOfWallTime, validateTimezone, wallTimeOf } from './schedule.js';

export const USAGE_TOKEN_FIELDS = [
	'input_tokens',
	'output_tokens',
	'cache_read_tokens',
	'cache_write_tokens'
] as const;
export type UsageTokenField = (typeof USAGE_TOKEN_FIELDS)[number];
export type UsageBy = 'project' | 'workflow' | 'state' | 'outcome' | 'runner' | 'tier';
export type UsageWindow = 'today' | '7d' | '30d';
export type UsageAccountingStatus = 'priced' | 'unpriced' | 'unreported';
export type UsageCoverage = 'complete' | 'partial' | 'unknown' | 'empty';

export class UsageInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UsageInputError';
	}
}

export interface UsagePeriodInput {
	window?: UsageWindow;
	from?: string;
	to?: string;
}
export interface ResolvedUsagePeriod {
	from: number;
	to: number;
	generated_at: number;
	timezone: string;
	timezone_source: 'supervisor_budget' | 'utc_fallback';
}

function validDateParts(text: string): { year: number; month: number; day: number } | null {
	const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!match) return null;
	const year = Number(match[1]),
		month = Number(match[2]),
		day = Number(match[3]);
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
		? { year, month, day }
		: null;
}

function parseBound(text: string, timezone: string): number {
	const date = validDateParts(text);
	if (date) {
		const instants = instantsOfWallTime({ ...date, hour: 0, minute: 0 }, timezone);
		if (!instants.length)
			throw new UsageInputError(
				`Local midnight ${text} does not exist in ${timezone}; use an offset timestamp`
			);
		return instants[0];
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
		throw new UsageInputError(
			'Bounds must be YYYY-MM-DD or ISO timestamps with an explicit offset'
		);
	}
	const result = Date.parse(text);
	if (!Number.isFinite(result)) throw new UsageInputError('Invalid time bound');
	return result;
}

export function resolveUsagePeriod(
	input: UsagePeriodInput,
	configuredTimezone: unknown,
	generatedAt = Date.now()
): ResolvedUsagePeriod {
	let timezone = 'UTC';
	let timezone_source: ResolvedUsagePeriod['timezone_source'] = 'utc_fallback';
	if (typeof configuredTimezone === 'string') {
		try {
			timezone = validateTimezone(configuredTimezone);
			timezone_source = 'supervisor_budget';
		} catch {
			/* fallback */
		}
	}
	if (input.window && (input.from !== undefined || input.to !== undefined))
		throw new UsageInputError('window cannot be combined with from/to');
	if ((input.from === undefined) !== (input.to === undefined))
		throw new UsageInputError('from and to are required together');
	let from: number;
	let to: number;
	if (input.from !== undefined && input.to !== undefined) {
		from = parseBound(input.from, timezone);
		to = parseBound(input.to, timezone);
	} else {
		const window = input.window ?? 'today';
		if (!['today', '7d', '30d'].includes(window))
			throw new UsageInputError('window must be today, 7d, or 30d');
		to = generatedAt;
		if (window === 'today') {
			const wall = wallTimeOf(generatedAt, timezone);
			let candidates = instantsOfWallTime({ ...wall, hour: 0, minute: 0 }, timezone);
			for (let minute = 1; candidates.length === 0 && minute < 180; minute++) {
				candidates = instantsOfWallTime(
					{ ...wall, hour: Math.floor(minute / 60), minute: minute % 60 },
					timezone
				);
			}
			if (!candidates.length)
				throw new UsageInputError('Could not resolve today in configured timezone');
			from = candidates[0];
		} else from = generatedAt - (window === '7d' ? 168 : 720) * 3_600_000;
	}
	if (from >= to) throw new UsageInputError('from must be before to');
	if (to > generatedAt) throw new UsageInputError('to cannot be in the future');
	return { from, to, generated_at: generatedAt, timezone, timezone_source };
}

export interface UsageDiagnostics {
	legacy_null: number;
	explicit_none: number;
	malformed: number;
	invalid_cost: number;
	invalid_token_fields: number;
	partial_token_fields: number;
	unknown_or_inconsistent_source: number;
	invalid_or_missing_calculated_basis: number;
}

export interface UsageClassification {
	status: UsageAccountingStatus;
	usage: Record<string, unknown> | null;
	cost: number | null;
	cost_exact: string | null;
	source: 'provider' | 'calculated' | 'unknown_source' | null;
	basis: RunPricingBasisV1 | null;
	tokens: Record<UsageTokenField, number | null>;
	invalid_tokens: UsageTokenField[];
	diagnostics: UsageDiagnostics;
	pricing_reason: RunPricingReason | null;
}

export interface UsageCostPortion {
	priced_run_count: number;
	cost_usd: number;
	cost_usd_exact: string;
}

export interface UsageRatePortion extends UsageCostPortion {
	basis: Omit<RunPricingBasisV1, 'cost_usd_exact' | 'rate_selected_at'> | null;
	rate_selected_at_min: number | null;
	rate_selected_at_max: number | null;
}

export interface UsageAggregate {
	finalized_run_count: number;
	priced_run_count: number;
	unpriced_run_count: number;
	unreported_run_count: number;
	coverage: UsageCoverage;
	cost_usd: number | null;
	cost_usd_exact: string | null;
	portions: Record<'provider' | 'calculated' | 'unknown_source', UsageCostPortion>;
	tokens: Record<
		UsageTokenField,
		{ value: number | null; reported_runs: number; invalid_runs: number }
	>;
	diagnostics: UsageDiagnostics;
	pricing_reasons: Partial<Record<RunPricingReason, number>>;
	rate_portions: UsageRatePortion[];
	distribution: {
		subset: 'priced_finalized_runs';
		sample_count: number;
		missing_price_count: number;
		mean_cost_usd: number | null;
		median_cost_usd: number | null;
		p95_cost_usd: number | null;
		max_cost_usd: number | null;
		percentile_rule: 'nearest_rank';
		low_sample: boolean;
	};
}

export interface UsageDimension {
	id: string | null;
	name: string;
	workflow_id?: string | null;
	workflow_name?: string | null;
}

export interface UsageGroup {
	key: string;
	dimension: UsageDimension;
	aggregate: UsageAggregate;
}

export interface ResolvedUsageFilters {
	project?: string;
	workflow?: string;
	state?: string;
	runner?: string;
	tier?: string;
	outcome?: 'advanced' | 'stalled' | 'interrupted' | 'unknown';
	accounting_status?: UsageAccountingStatus;
}

export interface UsageReport {
	from: number;
	to: number;
	generated_at: number;
	timezone: string;
	timezone_source: 'supervisor_budget' | 'utc_fallback';
	accounting_basis: 'finalized_by_ended_at_v1';
	attribution_basis: 'current_issue_project_start_state_workflow_v1';
	filters: ResolvedUsageFilters;
	by: UsageBy;
	scope_total: UsageAggregate;
	matching_total: UsageAggregate;
	groups: UsageGroup[];
	workflow_options: UsageDimension[];
	pending: {
		scope_count: number;
		matching_count: number;
		basis: 'created_before_cutoff_not_ended_before_cutoff';
		unapplied_filters: ('outcome' | 'accounting_status')[];
	};
	evidence_filters: ResolvedUsageFilters & { from: string; to: string; population: 'finalized' };
}

const emptyDiagnostics = (): UsageDiagnostics => ({
	legacy_null: 0,
	explicit_none: 0,
	malformed: 0,
	invalid_cost: 0,
	invalid_token_fields: 0,
	partial_token_fields: 0,
	unknown_or_inconsistent_source: 0,
	invalid_or_missing_calculated_basis: 0
});

const usable = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0;

function parseObject(raw: unknown): { value: Record<string, unknown> | null; malformed: boolean } {
	if (raw === null || raw === undefined || raw === '') return { value: null, malformed: false };
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw) as unknown;
		} catch {
			return { value: null, malformed: true };
		}
	}
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? { value: value as Record<string, unknown>, malformed: false }
		: { value: null, malformed: true };
}

function validBasis(value: unknown): value is RunPricingBasisV1 {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const b = value as Record<string, unknown>;
	return (
		b.calculation_version === 'tokens-times-usd-per-million-v1' &&
		typeof b.rate_id === 'string' &&
		typeof b.cost_usd_exact === 'string' &&
		/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(b.cost_usd_exact) &&
		Number.isFinite(Number(b.cost_usd_exact))
	);
}

/** Classify the raw persisted value before a forgiving API parser can erase malformed history. */
export function classifyUsage(raw: unknown): UsageClassification {
	const diagnostics = emptyDiagnostics();
	const parsed = parseObject(raw);
	if (parsed.malformed) diagnostics.malformed++;
	if (raw === null || raw === undefined || raw === '') diagnostics.legacy_null++;
	const usage = parsed.value;
	const tokens = {} as Record<UsageTokenField, number | null>;
	const invalid_tokens: UsageTokenField[] = [];
	let tokenCount = 0;
	for (const field of USAGE_TOKEN_FIELDS) {
		const value = usage?.[field];
		if (usable(value)) {
			tokens[field] = value;
			tokenCount++;
		} else {
			tokens[field] = null;
			if (value !== undefined) invalid_tokens.push(field);
		}
	}
	diagnostics.invalid_token_fields += invalid_tokens.length;
	if (tokenCount > 0 && tokenCount < USAGE_TOKEN_FIELDS.length) diagnostics.partial_token_fields++;
	const source = usage?.cost_source;
	if (source === 'none') diagnostics.explicit_none++;
	const costValue = usage?.cost_usd;
	const hasCost = usable(costValue);
	if (costValue !== undefined && !hasCost) diagnostics.invalid_cost++;
	const pricing = usage?.pricing as Record<string, unknown> | undefined;
	const pricingStatus = pricing && typeof pricing === 'object' ? pricing.status : undefined;
	const basis = pricingStatus === 'calculated' && validBasis(pricing?.basis) ? pricing.basis : null;
	let costExact = hasCost ? String(costValue) : null;
	if (hasCost && source === 'priced') {
		if (!basis || Math.abs(Number(basis.cost_usd_exact) - costValue) > 1e-12) {
			diagnostics.invalid_or_missing_calculated_basis++;
		} else costExact = basis.cost_usd_exact;
	}
	if (
		(source !== undefined && !['provider', 'priced', 'none'].includes(String(source))) ||
		(source === 'none' && (hasCost || tokenCount > 0)) ||
		(source === 'provider' && pricingStatus === 'calculated')
	)
		diagnostics.unknown_or_inconsistent_source++;
	const status: UsageAccountingStatus = hasCost
		? 'priced'
		: tokenCount > 0
			? 'unpriced'
			: 'unreported';
	return {
		status,
		usage,
		cost: hasCost ? costValue : null,
		cost_exact: costExact,
		source: hasCost
			? source === 'provider'
				? 'provider'
				: source === 'priced'
					? 'calculated'
					: 'unknown_source'
			: null,
		basis,
		tokens,
		invalid_tokens,
		diagnostics,
		pricing_reason:
			pricingStatus === 'unpriced' && typeof pricing?.reason === 'string'
				? (pricing.reason as RunPricingReason)
				: null
	};
}

type Decimal = { coefficient: bigint; scale: number };
function decimalOf(value: string): Decimal {
	const match = value.toLowerCase().match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
	if (!match) throw new Error('usage_value_out_of_range');
	const fraction = match[2] ?? '';
	const exponent = Number(match[3] ?? 0);
	let coefficient = BigInt(`${match[1]}${fraction}`);
	let scale = fraction.length - exponent;
	if (scale < 0) {
		coefficient *= 10n ** BigInt(-scale);
		scale = 0;
	}
	return { coefficient, scale };
}
function addDecimal(a: Decimal, b: Decimal): Decimal {
	const scale = Math.max(a.scale, b.scale);
	return {
		coefficient:
			a.coefficient * 10n ** BigInt(scale - a.scale) +
			b.coefficient * 10n ** BigInt(scale - b.scale),
		scale
	};
}
function decimalString(value: Decimal): string {
	let digits = value.coefficient.toString();
	if (value.scale === 0) return digits;
	digits = digits.padStart(value.scale + 1, '0');
	const out = `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(
		/(?:\.0+|(?<=\..*?)0+)$/,
		''
	);
	return out.endsWith('.') ? out.slice(0, -1) : out;
}

export function aggregateUsage(values: unknown[]): UsageAggregate {
	const classifications = values.map(classifyUsage);
	let exact: Decimal = { coefficient: 0n, scale: 0 };
	const samples: number[] = [];
	const diagnostics = emptyDiagnostics();
	const pricing_reasons: Partial<Record<RunPricingReason, number>> = {};
	const tokenSums = Object.fromEntries(
		USAGE_TOKEN_FIELDS.map((f) => [f, { value: 0, reported_runs: 0, invalid_runs: 0 }])
	) as UsageAggregate['tokens'];
	const portionState = Object.fromEntries(
		['provider', 'calculated', 'unknown_source'].map((s) => [
			s,
			{ count: 0, exact: { coefficient: 0n, scale: 0 } }
		])
	) as Record<string, { count: number; exact: Decimal }>;
	for (const item of classifications) {
		for (const key of Object.keys(diagnostics) as (keyof UsageDiagnostics)[])
			diagnostics[key] += item.diagnostics[key];
		if (item.pricing_reason)
			pricing_reasons[item.pricing_reason] = (pricing_reasons[item.pricing_reason] ?? 0) + 1;
		for (const field of USAGE_TOKEN_FIELDS) {
			if (item.tokens[field] !== null) {
				tokenSums[field].value = (tokenSums[field].value ?? 0) + item.tokens[field]!;
				tokenSums[field].reported_runs++;
			}
			if (item.invalid_tokens.includes(field)) tokenSums[field].invalid_runs++;
		}
		if (item.cost !== null && item.cost_exact && item.source) {
			const d = decimalOf(item.cost_exact);
			exact = addDecimal(exact, d);
			portionState[item.source].count++;
			portionState[item.source].exact = addDecimal(portionState[item.source].exact, d);
			samples.push(item.cost);
		}
	}
	for (const field of USAGE_TOKEN_FIELDS)
		if (tokenSums[field].reported_runs === 0) tokenSums[field].value = null;
	samples.sort((a, b) => a - b);
	const n = samples.length;
	const exactString = decimalString(exact);
	const projected = Number(exactString);
	if (!Number.isFinite(projected)) throw new Error('usage_value_out_of_range');
	const median =
		n === 0 ? null : n % 2 ? samples[(n - 1) / 2] : (samples[n / 2 - 1] + samples[n / 2]) / 2;
	const portions = Object.fromEntries(
		Object.entries(portionState).map(([key, p]) => {
			const cost_usd_exact = decimalString(p.exact);
			return [key, { priced_run_count: p.count, cost_usd: Number(cost_usd_exact), cost_usd_exact }];
		})
	) as UsageAggregate['portions'];
	const unpriced = classifications.filter((v) => v.status === 'unpriced').length;
	const unreported = classifications.length - n - unpriced;
	return {
		finalized_run_count: values.length,
		priced_run_count: n,
		unpriced_run_count: unpriced,
		unreported_run_count: unreported,
		coverage:
			values.length === 0
				? 'empty'
				: n === values.length
					? 'complete'
					: n === 0
						? 'unknown'
						: 'partial',
		cost_usd: n ? projected : null,
		cost_usd_exact: n ? exactString : null,
		portions,
		tokens: tokenSums,
		diagnostics,
		pricing_reasons,
		rate_portions: [],
		distribution: {
			subset: 'priced_finalized_runs',
			sample_count: n,
			missing_price_count: values.length - n,
			mean_cost_usd: n ? projected / n : null,
			median_cost_usd: median,
			p95_cost_usd: n ? samples[Math.ceil(0.95 * n) - 1] : null,
			max_cost_usd: n ? samples[n - 1] : null,
			percentile_rule: 'nearest_rank',
			low_sample: n > 0 && n < 20
		}
	};
}

export function usageCostLabel(cost: number | null, finalized = 1): string {
	if (finalized === 0) return 'No runs';
	if (cost === null) return 'Unknown';
	if (cost === 0) return '$0';
	if (cost < 0.01) return '<$0.01';
	return cost.toLocaleString('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});
}
