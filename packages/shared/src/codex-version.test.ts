import { describe, expect, it } from 'vitest';
import { CODEX_ROLLOUT_MIN_VERSION, isSupportedCodexRolloutVersion } from './codex-version.js';

describe('isSupportedCodexRolloutVersion', () => {
	it('accepts the minimum version and anything newer', () => {
		expect(CODEX_ROLLOUT_MIN_VERSION).toBe('0.153.4');
		for (const version of ['0.153.4', '0.153.5', '0.154.0', '0.200.0', '1.0.0', '10.2.3'])
			expect(isSupportedCodexRolloutVersion(version), version).toBe(true);
	});

	it('rejects older, pre-release, and malformed versions', () => {
		for (const version of [
			'0.153.3',
			'0.152.9',
			'0.99.99',
			'0.153.4-alpha.1',
			'v0.153.4',
			'0.153',
			'0.153.04',
			'',
			undefined,
			null,
			1534
		])
			expect(isSupportedCodexRolloutVersion(version), String(version)).toBe(false);
	});
});
