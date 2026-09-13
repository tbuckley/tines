import type {
	AgentRun,
	AgentRunUsage,
	IssueRef,
	RunPricingBasisV1,
	RunPricingReason,
	UsagePendingRun
} from './types.js';
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
	constructor(
		message: string,
		public readonly field?: string,
		public readonly remedy?: string
	) {
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

export function parseUsageBound(text: string, timezone: string, allowDateOnly = true): number {
	const date = validDateParts(text);
	if (date) {
		if (!allowDateOnly)
			throw new UsageInputError('Bounds must be ISO timestamps with an explicit offset');
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
	const match = text.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/
	);
	if (!match) throw new UsageInputError('Invalid time bound');
	const [, y, mo, d, h, mi, s = '0', fraction = '', zone, sign, oh = '0', om = '0'] = match;
	if (!validDateParts(`${y}-${mo}-${d}`) || +h > 23 || +mi > 59 || +s > 59 || +oh > 23 || +om > 59)
		throw new UsageInputError('Invalid time bound');
	const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +(fraction + '00').slice(0, 3));
	const offset = zone === 'Z' ? 0 : (+oh * 60 + +om) * 60_000 * (sign === '+' ? 1 : -1);
	const result = local - offset;
	if (!Number.isSafeInteger(result)) throw new UsageInputError('Invalid time bound');
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
		from = parseUsageBound(input.from, timezone);
		to = parseUsageBound(input.to, timezone);
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

export type UsageDimensions = Record<UsageBy, UsageDimension>;
export type UsageEvidenceAccounting = Omit<UsageClassification, 'usage'>;

export interface UsageGroup {
	key: string;
	dimension: UsageDimension;
	aggregate: UsageAggregate;
	scope?: string;
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
	mode?: 'period';
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
	scope_evidence_filters: UsageEvidenceFilters;
	matching_evidence_filters: UsageEvidenceFilters;
	pending_evidence_filters: Omit<
		UsageEvidenceFilters,
		'outcome' | 'accounting_status' | 'population'
	> & {
		population: 'pending';
	};
	/** Compatibility alias for matching_evidence_filters. */
	evidence_filters: UsageEvidenceFilters;
	scope?: string;
	scope_total_scope?: string;
	matching_scope?: string;
	pending_scope?: string;
}

export interface IssueUsageReport {
	mode: 'issue';
	cutoff: number;
	generated_at: number;
	timezone: string;
	timezone_source: ResolvedUsagePeriod['timezone_source'];
	accounting_basis: 'finalized_before_cutoff_v1';
	retention_basis: 'retained_direct_attempts';
	metadata_basis: 'current_owned_or_retained';
	accounting_version: 1;
	scope?: string;
	issue: {
		issue_id: string;
		issue_ref: IssueRef | null;
		aggregate: UsageAggregate;
		attempt_count: number;
		pending_count: number;
		fully_priced: boolean;
	};
}

export interface IssueAttemptUsage {
	issue_id: string | null;
	issue_ref: IssueRef | null;
	aggregate: UsageAggregate;
	attempt_count: number;
	pending_count: number;
	fully_priced: boolean;
	latest_at: number;
}

export interface UsageRatio {
	numerator: number;
	denominator: number;
	value: number | null;
}
export interface KnownCostMean {
	numerator_usd_exact: string | null;
	denominator: number;
	value_usd: number | null;
	coverage: UsageCoverage;
}
export interface CohortCounters {
	distinct_issue_count: number;
	attempt_count: number;
	pending_count: number;
	zero_run_issue_count: number;
	pending_only_issue_count: number;
	fully_priced_issue_count: number;
	reopened_issue_count: number;
	reopening_history_unavailable_issue_count: number;
	mean_attempts_per_issue: UsageRatio;
	known_cost_per_issue: KnownCostMean;
	priced_run_coverage: UsageRatio;
	fully_priced_issue_coverage: UsageRatio;
}
export interface CohortStateProof {
	id: string;
	name: string;
	category: 'done';
	basis: 'current_definition' | 'recorded_entry';
	proof_event_id: string | null;
}
export interface CohortEntry {
	event_id: string;
	event_type: 'issue.created' | 'issue.transitioned' | 'issue.updated';
	issue_id: string | null;
	project_id: string | null;
	workflow_id: string | null;
	workflow_name: string | null;
	state_id: string | null;
	state_name: string | null;
	category: string | null;
	identity_basis: 'recorded_entry' | 'current_definition' | 'selection_metadata' | null;
	created_at: number;
	qualifies: boolean;
	chosen: boolean;
	reopening_relevant: boolean;
	unavailable_reason: string | null;
}
export interface CohortHistory {
	status: 'event_recorded' | 'definition_based' | 'partial' | 'unavailable';
	earliest_retained_at: number | null;
	examined_entry_count: number;
	qualifying_fact_count: number;
	definition_classified_count: number;
	missing_target_id_count: number;
	unavailable_workflow_or_category_count: number;
	null_issue_count: number;
	malformed_count: number;
	unknown_project_count: number;
	from: number;
	to: number;
}
export interface CohortIssueUsage extends IssueAttemptUsage {
	issue_id: string;
	chosen_entry: CohortEntry;
	reopening: {
		value: boolean | null;
		witness: CohortEntry | null;
		unknown_later_entry_count: number;
		observed_through: number;
	};
}
export interface CohortUsageReport {
	mode: 'cohort';
	from: number;
	to: number;
	generated_at: number;
	observed_through: number;
	timezone: string;
	timezone_source: ResolvedUsagePeriod['timezone_source'];
	workflow: UsageDimension;
	selected_states: CohortStateProof[];
	selection_basis: 'all_current_done' | 'explicit' | 'retained_recorded_done' | 'unavailable';
	aggregate: UsageAggregate;
	counters: CohortCounters;
	terminal_states: {
		state: CohortStateProof;
		aggregate: UsageAggregate;
		counters: CohortCounters;
	}[];
	history: CohortHistory;
	accounting_basis: 'finalized_before_cutoff_v1';
	membership_basis: 'latest_qualifying_entry_v1';
	retention_basis: 'retained_direct_attempts';
	project_basis: 'event_project';
	accounting_version: 1;
	scope?: string;
}

export function cohortRatio(numerator: number, denominator: number): UsageRatio {
	return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

export function cohortKnownCostMean(
	numerator: string | null,
	denominator: number,
	fullyPriced: number
): KnownCostMean {
	const projected = numerator === null ? null : Number(numerator) / denominator;
	if (projected !== null && !Number.isFinite(projected))
		throw new Error('usage_value_out_of_range');
	return {
		numerator_usd_exact: numerator,
		denominator,
		value_usd: projected,
		coverage:
			denominator === 0
				? 'empty'
				: numerator === null
					? 'unknown'
					: fullyPriced === denominator
						? 'complete'
						: 'partial'
	};
}

export type UsageEvidenceItem =
	IssueAttemptUsage | AgentRunUsageEvidence | UsagePendingRun | CohortEntry;
export interface AgentRunUsageEvidence extends AgentRun {
	usage_accounting: UsageEvidenceAccounting;
}
export interface UsageEvidencePage<T extends UsageEvidenceItem = UsageEvidenceItem> {
	items: T[];
	next_cursor: string | null;
	previous_cursor: string | null;
	total_count: number;
	scope: string;
	kind: 'issues' | 'runs' | 'entries';
	population: 'all' | 'finalized' | 'pending';
	sort: 'cost' | 'time';
	direction: 'asc' | 'desc';
	matching_total: UsageAggregate;
	parent_matching_total?: UsageAggregate;
	attempt_count: number;
	pending_count: number;
}

export type UsageEvidenceFilters = ResolvedUsageFilters & {
	from: string;
	to: string;
	population: 'finalized';
	timezone: string;
	timezone_source: ResolvedUsagePeriod['timezone_source'];
};

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
export function compareUsageDecimals(a: string, b: string): number {
	const left = decimalOf(a);
	const right = decimalOf(b);
	const scale = Math.max(left.scale, right.scale);
	const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
	const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
	return leftCoefficient === rightCoefficient ? 0 : leftCoefficient < rightCoefficient ? -1 : 1;
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

type RateState = {
	basis: UsageRatePortion['basis'];
	count: number;
	exact: Decimal;
	min: number | null;
	max: number | null;
};

export class UsageSampleBuffer {
	private values = new Float64Array(0);
	length = 0;
	private ordered = true;

	add(value: number): void {
		if (this.length === this.values.length) {
			const next = new Float64Array(Math.max(1, this.values.length * 2));
			next.set(this.values);
			this.values = next;
		}
		this.values[this.length++] = value;
		this.ordered = false;
	}

	sorted(): Float64Array {
		const used = this.values.subarray(0, this.length);
		if (!this.ordered) {
			used.sort();
			this.ordered = true;
		}
		return used;
	}

	get capacity(): number {
		return this.values.length;
	}
}

export interface UsageAccumulator {
	finalized: number;
	priced: number;
	unpriced: number;
	unreported: number;
	exact: Decimal;
	diagnostics: UsageDiagnostics;
	pricing_reasons: Partial<Record<RunPricingReason, number>>;
	tokens: UsageAggregate['tokens'];
	portions: Record<'provider' | 'calculated' | 'unknown_source', { count: number; exact: Decimal }>;
	rates: Map<string, RateState>;
	samples: UsageSampleBuffer;
}

export function createUsageAccumulator(): UsageAccumulator {
	return {
		finalized: 0,
		priced: 0,
		unpriced: 0,
		unreported: 0,
		exact: { coefficient: 0n, scale: 0 },
		diagnostics: emptyDiagnostics(),
		pricing_reasons: {},
		tokens: Object.fromEntries(
			USAGE_TOKEN_FIELDS.map((f) => [f, { value: 0, reported_runs: 0, invalid_runs: 0 }])
		) as UsageAggregate['tokens'],
		portions: Object.fromEntries(
			['provider', 'calculated', 'unknown_source'].map((s) => [
				s,
				{ count: 0, exact: { coefficient: 0n, scale: 0 } }
			])
		) as UsageAccumulator['portions'],
		rates: new Map(),
		samples: new UsageSampleBuffer()
	};
}

export function addUsageClassification(acc: UsageAccumulator, item: UsageClassification): void {
	acc.finalized++;
	acc[item.status]++;
	for (const key of Object.keys(acc.diagnostics) as (keyof UsageDiagnostics)[])
		acc.diagnostics[key] += item.diagnostics[key];
	if (item.pricing_reason)
		acc.pricing_reasons[item.pricing_reason] = (acc.pricing_reasons[item.pricing_reason] ?? 0) + 1;
	for (const field of USAGE_TOKEN_FIELDS) {
		if (item.tokens[field] !== null) {
			acc.tokens[field].value = (acc.tokens[field].value ?? 0) + item.tokens[field]!;
			acc.tokens[field].reported_runs++;
		}
		if (item.invalid_tokens.includes(field)) acc.tokens[field].invalid_runs++;
	}
	if (item.cost !== null && item.cost_exact && item.source) {
		const d = decimalOf(item.cost_exact);
		acc.exact = addDecimal(acc.exact, d);
		acc.portions[item.source].count++;
		acc.portions[item.source].exact = addDecimal(acc.portions[item.source].exact, d);
		if (item.source === 'calculated') {
			const basis = item.basis;
			const identity = basis
				? (Object.fromEntries(
						Object.entries(basis).filter(
							([key]) => key !== 'cost_usd_exact' && key !== 'rate_selected_at'
						)
					) as UsageRatePortion['basis'])
				: null;
			const key = JSON.stringify(identity);
			const selected = basis?.rate_selected_at ?? null;
			const rate = acc.rates.get(key) ?? {
				basis: identity,
				count: 0,
				exact: { coefficient: 0n, scale: 0 },
				min: selected,
				max: selected
			};
			rate.count++;
			rate.exact = addDecimal(rate.exact, d);
			if (selected !== null) {
				rate.min = rate.min === null ? selected : Math.min(rate.min, selected);
				rate.max = rate.max === null ? selected : Math.max(rate.max, selected);
			}
			acc.rates.set(key, rate);
		}
		acc.samples.add(item.cost);
	}
}

export function addUsage(acc: UsageAccumulator, raw: unknown): UsageClassification {
	const item = classifyUsage(raw);
	addUsageClassification(acc, item);
	return item;
}

export function mergeUsageCounters(target: UsageAccumulator, source: UsageAccumulator): void {
	target.finalized += source.finalized;
	target.priced += source.priced;
	target.unpriced += source.unpriced;
	target.unreported += source.unreported;
	target.exact = addDecimal(target.exact, source.exact);
	for (const key of Object.keys(target.diagnostics) as (keyof UsageDiagnostics)[])
		target.diagnostics[key] += source.diagnostics[key];
	for (const [reason, count] of Object.entries(source.pricing_reasons) as [
		RunPricingReason,
		number
	][])
		target.pricing_reasons[reason] = (target.pricing_reasons[reason] ?? 0) + count;
	for (const field of USAGE_TOKEN_FIELDS) {
		target.tokens[field].value =
			(target.tokens[field].value ?? 0) + (source.tokens[field].value ?? 0);
		target.tokens[field].reported_runs += source.tokens[field].reported_runs;
		target.tokens[field].invalid_runs += source.tokens[field].invalid_runs;
	}
	for (const sourceName of ['provider', 'calculated', 'unknown_source'] as const) {
		target.portions[sourceName].count += source.portions[sourceName].count;
		target.portions[sourceName].exact = addDecimal(
			target.portions[sourceName].exact,
			source.portions[sourceName].exact
		);
	}
	for (const [key, value] of source.rates) {
		const rate = target.rates.get(key) ?? {
			basis: value.basis,
			count: 0,
			exact: { coefficient: 0n, scale: 0 },
			min: null,
			max: null
		};
		rate.count += value.count;
		rate.exact = addDecimal(rate.exact, value.exact);
		if (value.min !== null)
			rate.min = rate.min === null ? value.min : Math.min(rate.min, value.min);
		if (value.max !== null)
			rate.max = rate.max === null ? value.max : Math.max(rate.max, value.max);
		target.rates.set(key, rate);
	}
}

export function* mergeSortedUsageSamples(buffers: Iterable<UsageSampleBuffer>): Iterable<number> {
	const arrays = [...buffers].map((buffer) => buffer.sorted());
	const positions = arrays.map(() => 0);
	const heap = arrays.flatMap((array, index) => (array.length ? [index] : []));
	const less = (left: number, right: number) =>
		arrays[left][positions[left]] < arrays[right][positions[right]];
	const down = (root: number) => {
		for (;;) {
			const left = root * 2 + 1;
			if (left >= heap.length) return;
			const right = left + 1;
			const child = right < heap.length && less(heap[right], heap[left]) ? right : left;
			if (!less(heap[child], heap[root])) return;
			[heap[root], heap[child]] = [heap[child], heap[root]];
			root = child;
		}
	};
	for (let i = Math.floor(heap.length / 2) - 1; i >= 0; i--) down(i);
	while (heap.length) {
		const selected = heap[0];
		yield arrays[selected][positions[selected]++];
		if (positions[selected] === arrays[selected].length) {
			heap[0] = heap.at(-1)!;
			heap.pop();
		}
		if (heap.length) down(0);
	}
}

export function finalizeUsage(
	acc: UsageAccumulator,
	sortedSamples: Iterable<number> = acc.samples.sorted()
): UsageAggregate {
	const tokens = structuredClone(acc.tokens);
	for (const field of USAGE_TOKEN_FIELDS)
		if (tokens[field].reported_runs === 0) tokens[field].value = null;
	const n = acc.priced;
	const exactString = decimalString(acc.exact);
	const projected = Number(exactString);
	if (!Number.isFinite(projected)) throw new Error('usage_value_out_of_range');
	const lowerMedianRank = n === 0 ? -1 : Math.floor((n - 1) / 2);
	const upperMedianRank = n === 0 ? -1 : Math.floor(n / 2);
	const p95Rank = n === 0 ? -1 : Math.ceil(0.95 * n) - 1;
	let lowerMedian: number | null = null;
	let upperMedian: number | null = null;
	let p95: number | null = null;
	let max: number | null = null;
	let sampleCount = 0;
	for (const sample of sortedSamples) {
		if (sampleCount === lowerMedianRank) lowerMedian = sample;
		if (sampleCount === upperMedianRank) upperMedian = sample;
		if (sampleCount === p95Rank) p95 = sample;
		max = sample;
		sampleCount++;
	}
	if (sampleCount !== n) throw new Error('usage_sample_count_mismatch');
	const median =
		lowerMedian === null || upperMedian === null ? null : lowerMedian / 2 + upperMedian / 2;
	const portions = Object.fromEntries(
		Object.entries(acc.portions).map(([key, p]) => {
			const cost_usd_exact = decimalString(p.exact);
			return [key, { priced_run_count: p.count, cost_usd: Number(cost_usd_exact), cost_usd_exact }];
		})
	) as UsageAggregate['portions'];
	return {
		finalized_run_count: acc.finalized,
		priced_run_count: n,
		unpriced_run_count: acc.unpriced,
		unreported_run_count: acc.unreported,
		coverage:
			acc.finalized === 0
				? 'empty'
				: n === acc.finalized
					? 'complete'
					: n === 0
						? 'unknown'
						: 'partial',
		cost_usd: n ? projected : null,
		cost_usd_exact: n ? exactString : null,
		portions,
		tokens,
		diagnostics: { ...acc.diagnostics },
		pricing_reasons: { ...acc.pricing_reasons },
		rate_portions: [...acc.rates.values()].map((rate) => {
			const cost_usd_exact = decimalString(rate.exact);
			return {
				basis: rate.basis,
				priced_run_count: rate.count,
				cost_usd_exact,
				cost_usd: Number(cost_usd_exact),
				rate_selected_at_min: rate.min,
				rate_selected_at_max: rate.max
			};
		}),
		distribution: {
			subset: 'priced_finalized_runs',
			sample_count: n,
			missing_price_count: acc.finalized - n,
			mean_cost_usd: n ? projected / n : null,
			median_cost_usd: median,
			p95_cost_usd: p95,
			max_cost_usd: max,
			percentile_rule: 'nearest_rank',
			low_sample: n > 0 && n < 20
		}
	};
}

export function aggregateUsage(values: unknown[]): UsageAggregate {
	const acc = createUsageAccumulator();
	for (const value of values) addUsage(acc, value);
	return finalizeUsage(acc);
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
