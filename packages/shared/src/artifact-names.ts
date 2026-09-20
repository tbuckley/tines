/** Suggest a valid, unused artifact slot name from a display filename. */
export function suggestArtifactName(filename: string, usedNames: Iterable<string>): string {
	const leaf = filename.split(/[\\/]/).at(-1) ?? '';
	const lastDot = leaf.lastIndexOf('.');
	const stem = lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
	const normalized = stem
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 100)
		.replace(/-+$/g, '');
	const base = normalized || 'attachment';
	const used = new Set(usedNames);
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) {
		const suffix = `-${n}`;
		const candidate = `${base.slice(0, 100 - suffix.length).replace(/-+$/g, '')}${suffix}`;
		if (!used.has(candidate)) return candidate;
	}
}
