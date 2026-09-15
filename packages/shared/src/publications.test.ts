import { describe, expect, it } from 'vitest';
import {
	parsePublicSnapshotReference,
	publicationReviewDigest,
	publicationReuseNotice,
	validatePublicationMetadata
} from './publications.js';

describe('publication contract', () => {
	it('accepts only explicit non-email public identity and MIT', () => {
		expect(
			validatePublicationMetadata({
				display_name: '  Example Team ',
				license: 'MIT',
				license_year: 2026
			})
		).toEqual({
			display_name: 'Example Team',
			license: 'MIT',
			license_year: 2026
		});
		expect(() =>
			validatePublicationMetadata({
				display_name: 'owner@example.com',
				license: 'MIT',
				license_year: 2026
			})
		).toThrow(/not be an email/);
		expect(
			publicationReuseNotice({ display_name: 'Example Team', license: 'MIT', license_year: 2026 })
		).toContain('Copyright (c) 2026 Example Team');
	});

	it('domain-separates review hashes and includes metadata and selection', async () => {
		const base = {
			candidate_id: 'candidate_12345678901234567890',
			bytes_sha256: `sha256:${'1'.repeat(64)}`,
			metadata: { display_name: 'Example Team', license: 'MIT' as const, license_year: 2026 },
			source_witness_sha256: `sha256:${'2'.repeat(64)}`,
			selection: { schedules: [] }
		};
		const digest = await publicationReviewDigest(base);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(
			await publicationReviewDigest({ ...base, selection: { schedules: ['schedule:1'] } })
		).not.toBe(digest);
	});

	it('parses only exact canonical entry and download URLs', () => {
		const id = 'snapshot_12345678901234567890';
		expect(
			parsePublicSnapshotReference(`https://tines.example/p/${id}`, 'https://tines.example')
		).toBe(id);
		expect(
			parsePublicSnapshotReference(
				`https://tines.example/p/${id}/download`,
				'https://tines.example'
			)
		).toBe(id);
		expect(() =>
			parsePublicSnapshotReference(`https://other.example/p/${id}`, 'https://tines.example')
		).toThrow('external_source_requires_download');
		expect(() =>
			parsePublicSnapshotReference(`https://tines.example/p/${id}?next=https://evil.example`)
		).toThrow(/Invalid/);
	});
});
