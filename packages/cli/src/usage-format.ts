import type {
	RunPricingBasisV1,
	UsageAggregate,
	UsageDimensions,
	UsageEvidenceAccounting
} from '@tines/shared';

const present = (value: unknown): string =>
	value === null || value === undefined || value === '' ? 'unavailable' : String(value);

const instant = (value: unknown): string => {
	if (typeof value !== 'number') return present(value);
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : 'unavailable';
};

function basisLine(
	basis: Partial<RunPricingBasisV1> | null,
	selection?: { min: unknown; max: unknown }
) {
	if (!basis) return 'historical calculated amount · basis unavailable';
	const rates: Partial<Record<keyof RunPricingBasisV1['rates'], string | null>> =
		basis.rates && typeof basis.rates === 'object' ? basis.rates : {};
	return [
		`id ${present(basis.rate_id)}`,
		`version ${present(basis.rate_version)}`,
		`model ${present(basis.model)}`,
		`plan ${present(basis.plan)}`,
		`context ${present(basis.context_band)}`,
		`source ${present(basis.source_url)}`,
		`checked ${present(basis.source_checked_at)}`,
		`effective ${present(basis.source_effective_at)}`,
		`adopted ${instant(basis.rate_adopted_at)}`,
		`valid to ${instant(basis.rate_valid_to)}`,
		...(selection
			? [`selected ${instant(selection.min)} — ${instant(selection.max)}`]
			: [`selected ${instant(basis.rate_selected_at)}`]),
		`rates input=${present(rates.input_tokens)} cache-read=${present(rates.cache_read_tokens)} cache-write=${present(rates.cache_write_tokens)} output=${present(rates.output_tokens)} per ${present(basis.unit_tokens)} tokens`
	].join(' · ');
}

export function usageAggregateLines(label: string, aggregate: UsageAggregate): string[] {
	const nonzero = (record: object) =>
		Object.entries(record as Record<string, number | undefined>)
			.filter(([, count]) => typeof count === 'number' && count > 0)
			.map(([name, count]) => `${name}=${count}`)
			.join(' · ') || 'none';
	return [
		`${label} sources: provider ${aggregate.portions.provider.cost_usd_exact} (${aggregate.portions.provider.priced_run_count}) · calculated ${aggregate.portions.calculated.cost_usd_exact} (${aggregate.portions.calculated.priced_run_count}) · unknown ${aggregate.portions.unknown_source.cost_usd_exact} (${aggregate.portions.unknown_source.priced_run_count})`,
		`${label} diagnostics: ${nonzero(aggregate.diagnostics)}`,
		`${label} pricing reasons: ${nonzero(aggregate.pricing_reasons)}`,
		...aggregate.rate_portions.map(
			(portion) =>
				`${label} rate (${portion.cost_usd_exact}; ${portion.priced_run_count} runs): ${basisLine(portion.basis, { min: portion.rate_selected_at_min, max: portion.rate_selected_at_max })}`
		)
	];
}

export function usageEvidenceLines(
	id: string,
	dimensions: UsageDimensions,
	accounting: UsageEvidenceAccounting
): string[] {
	const dims = (['project', 'workflow', 'state', 'outcome', 'runner', 'tier'] as const)
		.map((name) => `${name}=${dimensions[name].name} [${dimensions[name].id ?? 'unknown'}]`)
		.join(' · ');
	const diagnostics = Object.entries(accounting.diagnostics)
		.filter(([, count]) => count > 0)
		.map(([name, count]) => `${name}=${count}`)
		.join(' · ');
	return [
		`Evidence ${id}: ${dims}`,
		`Accounting ${id}: ${accounting.status} · source ${accounting.source ?? 'unavailable'} · exact cost ${accounting.cost_exact ?? 'unavailable'}${accounting.pricing_reason ? ` · reason ${accounting.pricing_reason}` : ''}${diagnostics ? ` · diagnostics ${diagnostics}` : ''}`,
		...(accounting.source === 'calculated' ? [`Rate ${id}: ${basisLine(accounting.basis)}`] : [])
	];
}
