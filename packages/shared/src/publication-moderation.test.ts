import { describe, expect, it } from 'vitest';
import {
	moderationTextLength,
	validateModerationText,
	validatePublicationReportRequest
} from './publication-moderation';

describe('publication moderation validation', () => {
	it('normalizes plain text and counts Unicode code points', () => {
		expect(validateModerationText('one\r\n😀', false)).toBe('one\n😀');
		expect(moderationTextLength('😀')).toBe(1);
		expect(() => validateModerationText('x'.repeat(1001), false)).toThrow('1,000');
		expect(() => validateModerationText('hidden\0value', false)).toThrow('plain text');
	});

	it('requires a UUIDv4, explicit reason, and rejects unknown fields', () => {
		expect(
			validatePublicationReportRequest({
				request_id: '123e4567-e89b-42d3-a456-426614174000',
				reason: 'rights'
			})
		).toMatchObject({ reason: 'rights', note: '' });
		expect(() =>
			validatePublicationReportRequest({
				request_id: '123e4567-e89b-42d3-a456-426614174000',
				reason: 'rights',
				attachment: 'no'
			})
		).toThrow('unknown');
	});
});
