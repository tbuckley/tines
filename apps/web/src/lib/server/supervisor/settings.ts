/** Missing settings inherit the product default; stored zero remains an intentional stop. */
export function effectiveAutomationEnabled(stored: number | null | undefined): boolean {
	return stored == null || stored === 1;
}
