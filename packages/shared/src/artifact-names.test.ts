import { describe, expect, it } from 'vitest';
import { suggestArtifactName } from './artifact-names.js';

describe('suggestArtifactName', () => {
	it.each([
		['Screenshot 2026-09-19.png', 'screenshot-2026-09-19'],
		['résumé.pdf', 'resume'],
		['report.tar.gz', 'report-tar'],
		['.env', 'env'],
		['資料.png', 'attachment'],
		['folder\\A report!.PDF', 'a-report']
	])('suggests %s as %s', (filename, expected) => {
		expect(suggestArtifactName(filename, [])).toBe(expected);
	});

	it('reserves suffix space and skips used edited names', () => {
		const base = 'a'.repeat(100);
		expect(suggestArtifactName(`${base}.txt`, [base, `${'a'.repeat(98)}-2`])).toBe(
			`${'a'.repeat(98)}-3`
		);
	});
});
