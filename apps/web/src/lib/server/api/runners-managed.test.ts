/**
 * Managed-runner credential handling: ping-validated create/replace with the
 * key encrypted at rest and never serialized, the $5 default per-run cap,
 * and tier-override / budget validation.
 */
import { describe, expect, it } from 'vitest';
import { decryptSecret } from '$lib/server/crypto';
import { ApiFail, type ActorContext } from './core';
import {
	createRunner,
	updateRunner,
	validateRunnerBudget,
	validateTierOverrides,
	type ProviderKeyPing
} from './runners';
import { createTestDb, type TestDb } from './test-db';
import { seedBase, USER } from '../supervisor/test-fixtures';

const ENC_KEY = 'test-encryption-key';

const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function world(): TestDb {
	const t = createTestDb();
	seedBase(t);
	t.env.SECRET_ENCRYPTION_KEY = ENC_KEY;
	return t;
}

const okPing: ProviderKeyPing = () => Promise.resolve(null);
const badPing: ProviderKeyPing = () => Promise.resolve('Anthropic rejected the API key (401)');

describe('createRunner (claude_managed)', () => {
	it('pings, encrypts, defaults the $5 cap and managed concurrency', async () => {
		const t = world();
		const runner = await createRunner(
			t.db,
			t.env,
			actor,
			{ type: 'claude_managed', name: 'claude-cloud', api_key: 'sk-ant-key' },
			okPing
		);
		expect(runner.type).toBe('claude_managed');
		expect(runner.max_concurrent).toBe(3);
		expect(runner.online).toBe(true);
		expect(runner.has_api_key).toBe(true);
		expect(runner.budget).toEqual({ max_run_cost_usd: 5 });
		expect(runner.tier_models).toMatchObject({ smartest: 'claude-fable-5' });
		// Encrypted at rest — never the plaintext, and never serialized.
		const row = t.all('SELECT secret_enc FROM runner')[0] as { secret_enc: string };
		expect(row.secret_enc).not.toContain('sk-ant-key');
		expect(await decryptSecret(row.secret_enc, ENC_KEY)).toBe('sk-ant-key');
		expect(JSON.stringify(runner)).not.toContain('sk-ant-key');
		expect(JSON.stringify(runner)).not.toContain(row.secret_enc);
	});

	it('a failed ping creates nothing', async () => {
		const t = world();
		await expect(
			createRunner(
				t.db,
				t.env,
				actor,
				{ type: 'claude_managed', name: 'c', api_key: 'bad' },
				badPing
			)
		).rejects.toMatchObject({ code: 'invalid_api_key' });
		expect(t.all('SELECT * FROM runner')).toHaveLength(0);
	});

	it('requires the key, rejects user config, and lets an explicit {} budget mean uncapped', async () => {
		const t = world();
		await expect(
			createRunner(t.db, t.env, actor, { type: 'claude_managed', name: 'c' }, okPing)
		).rejects.toMatchObject({ code: 'invalid_field', details: { field: 'api_key' } });
		await expect(
			createRunner(
				t.db,
				t.env,
				actor,
				{ type: 'claude_managed', name: 'c', api_key: 'k', config: { anything: 1 } },
				okPing
			)
		).rejects.toMatchObject({ code: 'invalid_field', details: { field: 'config' } });
		const uncapped = await createRunner(
			t.db,
			t.env,
			actor,
			{ type: 'claude_managed', name: 'c', api_key: 'k', budget: {} },
			okPing
		);
		expect(uncapped.budget).toBeNull();
	});

	it('gemini stays gated behind its milestone', async () => {
		const t = world();
		await expect(
			createRunner(t.db, t.env, actor, { type: 'gemini_managed', name: 'g', api_key: 'k' }, okPing)
		).rejects.toMatchObject({ code: 'managed_runner_unavailable' });
	});
});

describe('updateRunner (managed credentials, tiers, budget)', () => {
	async function withRunner(t: TestDb) {
		return createRunner(
			t.db,
			t.env,
			actor,
			{ type: 'claude_managed', name: 'claude-cloud', api_key: 'sk-old' },
			okPing
		);
	}

	it('replace-key pings first; a bad paste leaves the working key in place', async () => {
		const t = world();
		const runner = await withRunner(t);
		await expect(
			updateRunner(t.db, t.env, actor, runner.id, { api_key: 'sk-bad' }, badPing)
		).rejects.toMatchObject({ code: 'invalid_api_key' });
		const before = t.all('SELECT secret_enc FROM runner')[0] as { secret_enc: string };
		expect(await decryptSecret(before.secret_enc, ENC_KEY)).toBe('sk-old');

		await updateRunner(t.db, t.env, actor, runner.id, { api_key: 'sk-new' }, okPing);
		const after = t.all('SELECT secret_enc FROM runner')[0] as { secret_enc: string };
		expect(await decryptSecret(after.secret_enc, ENC_KEY)).toBe('sk-new');
		// The rotation is on record; the value is not.
		const events = t.all("SELECT payload FROM event WHERE type = 'runner.updated'") as {
			payload: string;
		}[];
		expect(
			events.some((e) =>
				(JSON.parse(e.payload) as { changed: string[] }).changed.includes('api_key')
			)
		).toBe(true);
		expect(events.every((e) => !e.payload.includes('sk-new'))).toBe(true);
	});

	it('patches tier overrides and budget wholesale, null clearing them', async () => {
		const t = world();
		const runner = await withRunner(t);
		let updated = await updateRunner(t.db, t.env, actor, runner.id, {
			tiers: { smartest: { model: 'claude-opus-5', effort: 'high' } },
			budget: { max_run_cost_usd: 2, max_run_tokens: 500000 }
		});
		expect(updated.tiers).toEqual({ smartest: { model: 'claude-opus-5', effort: 'high' } });
		expect(updated.budget).toEqual({ max_run_cost_usd: 2, max_run_tokens: 500000 });
		updated = await updateRunner(t.db, t.env, actor, runner.id, { tiers: null, budget: null });
		expect(updated.tiers).toBeNull();
		expect(updated.budget).toBeNull();
	});

	it('local runners reject api_key', async () => {
		const t = world();
		const local = await createRunner(t.db, t.env, actor, { type: 'local', name: 'laptop' }, okPing);
		await expect(
			updateRunner(t.db, t.env, actor, local.id, { api_key: 'sk-x' }, okPing)
		).rejects.toMatchObject({ code: 'invalid_field', details: { field: 'api_key' } });
	});
});

describe('validators', () => {
	it('validateTierOverrides: closed tier set, model required, effort levels closed', () => {
		expect(validateTierOverrides(undefined)).toBeNull();
		expect(validateTierOverrides({})).toBeNull();
		expect(validateTierOverrides({ smartest: 'claude-opus-5' })).toEqual({
			smartest: { model: 'claude-opus-5' }
		});
		expect(() => validateTierOverrides({ turbo: { model: 'x' } })).toThrowError(ApiFail);
		expect(() => validateTierOverrides({ smartest: {} })).toThrowError(ApiFail);
		expect(() =>
			validateTierOverrides({ smartest: { model: 'x', effort: 'extreme' } })
		).toThrowError(ApiFail);
		expect(() => validateTierOverrides({ smartest: { model: 'x', unknown: 1 } })).toThrowError(
			ApiFail
		);
	});

	it('validateRunnerBudget: known fields, positive numbers, integer token caps', () => {
		expect(validateRunnerBudget(undefined)).toBeNull();
		expect(validateRunnerBudget({})).toBeNull();
		expect(validateRunnerBudget({ max_run_cost_usd: 2.5 })).toEqual({ max_run_cost_usd: 2.5 });
		expect(() => validateRunnerBudget({ max_run_cost_usd: 0 })).toThrowError(ApiFail);
		expect(() => validateRunnerBudget({ max_run_tokens: 1.5 })).toThrowError(ApiFail);
		expect(() => validateRunnerBudget({ weekly_usd: 1 })).toThrowError(ApiFail);
	});
});
