import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretHint, sha256Hex } from './crypto';

describe('sha256Hex', () => {
	it('hashes deterministically', async () => {
		expect(await sha256Hex('abc')).toBe(await sha256Hex('abc'));
		expect(await sha256Hex('abc')).not.toBe(await sha256Hex('abd'));
	});
});

describe('secret encryption', () => {
	it('round-trips', async () => {
		const stored = await encryptSecret('sk-ant-super-secret-value', 'key-material');
		expect(stored.startsWith('v1:')).toBe(true);
		expect(stored).not.toContain('super-secret');
		expect(await decryptSecret(stored, 'key-material')).toBe('sk-ant-super-secret-value');
	});

	it('uses a fresh IV per encryption (identical plaintexts differ at rest)', async () => {
		const a = await encryptSecret('same', 'key');
		const b = await encryptSecret('same', 'key');
		expect(a).not.toBe(b);
		expect(await decryptSecret(a, 'key')).toBe('same');
		expect(await decryptSecret(b, 'key')).toBe('same');
	});

	it('fails closed on the wrong key and on unreadable ciphertexts', async () => {
		const stored = await encryptSecret('value', 'right-key');
		await expect(decryptSecret(stored, 'wrong-key')).rejects.toThrow();
		await expect(decryptSecret('v2:aaaa:bbbb', 'right-key')).rejects.toThrow(/Unreadable/);
		await expect(decryptSecret('garbage', 'right-key')).rejects.toThrow(/Unreadable/);
	});
});

describe('secretHint', () => {
	it('shows shape, never most of the value', () => {
		const hint = secretHint('github_pat_11ABCDEFG0abcdefghij');
		expect(hint).toBe('github_p…ghij');
		expect(hint.length).toBeLessThan(15);
	});

	it('degrades short secrets to the ellipsis alone', () => {
		expect(secretHint('short')).toBe('…');
	});
});
