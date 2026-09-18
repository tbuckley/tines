import { describe, expect, it } from 'vitest';
import { hostModerationConfig, publicationConfig } from './config';

const ready = {
	PUBLIC_WORKFLOW_PUBLISHING_ENABLED: 'true',
	PUBLIC_WORKFLOW_MODERATOR_USER_IDS: 'u1',
	PUBLIC_WORKFLOW_REPORT_HMAC_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
	PUBLIC_WORKFLOW_APPEAL_CONTACT: 'mailto:appeals@example.test',
	PUBLIC_WORKFLOW_MODERATION_QUEUE_READY: 'true',
	PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED: 'true'
};

describe('publicationConfig', () => {
	it('defaults closed with bounded defaults', () => {
		expect(publicationConfig({} as Env)).toEqual({
			enabled: false,
			maxBytes: 1_048_576,
			dailyQuota: 10,
			valid: false,
			error: 'Invalid public workflow publication configuration; creation is disabled',
			missingReadiness: [
				'Assign a host reviewer',
				'Configure appeals',
				'Establish daily review',
				'Verify moderation'
			]
		});
	});

	it('enables only literal true and fails malformed limits closed', () => {
		expect(publicationConfig(ready as Env).enabled).toBe(true);
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

	it('validates private moderation settings without exposing them in publication config', () => {
		const host = hostModerationConfig(ready as Env);
		expect(host).toMatchObject({
			valid: true,
			reportHourlyQuota: 5,
			appealContact: 'mailto:appeals@example.test'
		});
		expect(host.moderatorUserIds.has('u1')).toBe(true);
		expect(JSON.stringify(publicationConfig(ready as Env))).not.toContain(
			ready.PUBLIC_WORKFLOW_REPORT_HMAC_SECRET
		);
	});
});
