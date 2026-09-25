import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPreviewLogin, signSessionToken, type PreviewLoginGate } from './preview-login';

const TOKEN = 'p'.repeat(40);
const open: PreviewLoginGate = {
	enabledInBuild: true,
	configuredToken: TOKEN,
	authorization: `Bearer ${TOKEN}`,
	hostname: 'pr-1-tines-web-preview.example.workers.dev'
};

describe('checkPreviewLogin', () => {
	it('accepts the configured token on a preview build', async () => {
		expect(await checkPreviewLogin(open)).toBe('ok');
	});

	it('does not exist outside preview builds, even with the right token', async () => {
		expect(await checkPreviewLogin({ ...open, enabledInBuild: false })).toBe('disabled');
	});

	it('does not exist when the worker has no token, or a short one', async () => {
		expect(await checkPreviewLogin({ ...open, configuredToken: undefined })).toBe('disabled');
		expect(await checkPreviewLogin({ ...open, configuredToken: '  ' })).toBe('disabled');
		expect(
			await checkPreviewLogin({ ...open, configuredToken: 'short', authorization: 'Bearer short' })
		).toBe('disabled');
	});

	it('does not exist on the production host', async () => {
		expect(await checkPreviewLogin({ ...open, hostname: 'tines.tbuckley.dev' })).toBe('disabled');
	});

	it('denies a missing, malformed or wrong token', async () => {
		expect(await checkPreviewLogin({ ...open, authorization: null })).toBe('denied');
		expect(await checkPreviewLogin({ ...open, authorization: TOKEN })).toBe('denied');
		expect(await checkPreviewLogin({ ...open, authorization: `Bearer ${TOKEN}x` })).toBe('denied');
	});
});

describe('signSessionToken', () => {
	it('matches the cookie format e2e/helpers.ts signs', async () => {
		const secret = 'secret-'.repeat(6);
		const expected = `tok.${createHmac('sha256', secret).update('tok').digest('base64')}`;
		expect(await signSessionToken('tok', secret)).toBe(expected);
	});
});
