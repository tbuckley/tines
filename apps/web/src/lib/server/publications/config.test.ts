import { describe, expect, it } from 'vitest';
import { publicationConfig } from './config';

describe('publicationConfig', () => {
	it('defaults closed with bounded defaults', () => {
		expect(publicationConfig({} as Env)).toEqual({
			enabled: false,
			maxBytes: 1_048_576,
			dailyQuota: 10,
			valid: true,
			error: null
		});
	});

	it('enables only literal true and fails malformed limits closed', () => {
		expect(publicationConfig({ PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true' } as Env).enabled).toBe(
			true
		);
		for (const value of ['TRUE', '1', 'yes']) {
			const config = publicationConfig({ PUBLIC_WORKFLOW_PUBLISHING_ENABLED: value } as Env);
			expect(config).toMatchObject({ enabled: false, valid: false });
		}
		expect(
			publicationConfig({
				PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
				PUBLIC_WORKFLOW_MAX_BYTES: '1048577'
			} as Env)
		).toMatchObject({ enabled: false, valid: false });
		expect(
			publicationConfig({
				PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
				PUBLIC_WORKFLOW_DAILY_QUOTA: '0'
			} as Env)
		).toMatchObject({ enabled: false, valid: false });
	});
});
