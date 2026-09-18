import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_URL, resolveApiKeySetting, resolveUrlSetting } from './common.js';
import { clearCliConfig, configPath, loadCliConfig, saveCliConfig } from './config.js';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'tines-cli-config-'));
	vi.stubEnv('TINES_CONFIG_DIR', dir);
	vi.stubEnv('TINES_API_URL', '');
	vi.stubEnv('TINES_API_KEY', '');
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

describe('the config file', () => {
	it('is empty until login writes it', () => {
		expect(loadCliConfig(dir)).toEqual({});
	});

	it('round-trips, merges partial updates, and strips a trailing slash from the url', () => {
		expect(saveCliConfig(dir, { url: 'https://t.example/' })).toEqual({ url: 'https://t.example' });
		expect(saveCliConfig(dir, { api_key: 'tines_k' })).toEqual({
			url: 'https://t.example',
			api_key: 'tines_k'
		});
		expect(loadCliConfig(dir)).toEqual({ url: 'https://t.example', api_key: 'tines_k' });
	});

	it('is written owner-only, since it holds a credential', () => {
		saveCliConfig(dir, { api_key: 'tines_k' });
		expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
	});

	it('is written atomically: a reader sees the old file or the new one, never a half', () => {
		// The marker a kept workspace wears is written the same way, and the
		// sweep that reads it polls — a half-written file read as empty JSON
		// is what made keep-workspaces flake on CI. The temp file is renamed
		// over the target, so it must never be left lying about either.
		saveCliConfig(dir, { url: 'https://one.test' });
		saveCliConfig(dir, { api_key: 'usr_key' });
		expect(loadCliConfig(dir)).toEqual({ url: 'https://one.test', api_key: 'usr_key' });
		expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
	});

	it('treats a corrupt or ill-typed file as empty rather than throwing', () => {
		writeFileSync(configPath(dir), '{not json');
		expect(loadCliConfig(dir)).toEqual({});
		writeFileSync(configPath(dir), JSON.stringify({ url: 42, api_key: '' }));
		expect(loadCliConfig(dir)).toEqual({});
	});

	it('logout removes it and reports whether there was one', () => {
		expect(clearCliConfig(dir)).toBe(false);
		saveCliConfig(dir, { api_key: 'tines_k' });
		expect(clearCliConfig(dir)).toBe(true);
		expect(loadCliConfig(dir)).toEqual({});
		expect(() => readFileSync(configPath(dir))).toThrow();
	});
});

describe('resolution order: flag, env, config, default', () => {
	it('falls back to the default with nothing set', () => {
		expect(resolveUrlSetting({})).toEqual({ value: DEFAULT_URL, source: 'default' });
		expect(resolveApiKeySetting({})).toEqual({ value: undefined, source: 'default' });
	});

	it('reads the stored config when neither the flag nor the env var is set', () => {
		saveCliConfig(dir, { url: 'https://stored.example', api_key: 'tines_stored' });
		expect(resolveUrlSetting({})).toEqual({ value: 'https://stored.example', source: 'config' });
		expect(resolveApiKeySetting({})).toEqual({ value: 'tines_stored', source: 'config' });
	});

	it('lets the env var beat the stored config, and the flag beat both', () => {
		saveCliConfig(dir, { url: 'https://stored.example', api_key: 'tines_stored' });
		vi.stubEnv('TINES_API_URL', 'https://env.example');
		vi.stubEnv('TINES_API_KEY', 'tines_env');
		expect(resolveUrlSetting({})).toEqual({ value: 'https://env.example', source: 'env' });
		expect(resolveApiKeySetting({})).toEqual({ value: 'tines_env', source: 'env' });
		expect(resolveUrlSetting({ url: 'https://flag.example' })).toEqual({
			value: 'https://flag.example',
			source: 'flag'
		});
		expect(resolveApiKeySetting({ apiKey: 'tines_flag' })).toEqual({
			value: 'tines_flag',
			source: 'flag'
		});
	});
});
