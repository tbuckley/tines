/**
 * The CLI config directory and the config file `tines login` writes there.
 *
 * Every command resolves its API URL and key in the same order: the flag,
 * then the env var, then this file, then the default. Agents keep using the
 * env vars their run is launched with (nothing here is consulted when
 * TINES_API_KEY is set); the file is for humans, who otherwise have to
 * export both variables in every shell before a single command works.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** `TINES_CONFIG_DIR` overrides (the e2e suite and tests point it at a tmp dir). */
export function defaultConfigDir(): string {
	return process.env.TINES_CONFIG_DIR ?? join(homedir(), '.config', 'tines');
}

export function readJsonFile<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		// A corrupt file is treated as absent rather than crashing the caller.
		return null;
	}
}

export function writeJsonFile(path: string, value: unknown, { secret = false } = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, secret ? { mode: 0o600 } : {});
}

// ---------------------------------------------------------------------------
// The login config (config.json)

export interface CliConfig {
	/** Base URL of the Tines API. */
	url?: string;
	/** A user API key (Settings → API keys in the web app). */
	api_key?: string;
}

export function configPath(dir: string = defaultConfigDir()): string {
	return join(dir, 'config.json');
}

/** The stored config, with anything that is not a string dropped. Never throws. */
export function loadCliConfig(dir: string = defaultConfigDir()): CliConfig {
	const raw = readJsonFile<Record<string, unknown>>(configPath(dir));
	const config: CliConfig = {};
	if (typeof raw?.url === 'string' && raw.url !== '') config.url = raw.url;
	if (typeof raw?.api_key === 'string' && raw.api_key !== '') config.api_key = raw.api_key;
	return config;
}

/**
 * Merges `patch` into the stored config and writes it back (mode 0600: it
 * holds a credential). Returns what is now stored.
 */
export function saveCliConfig(dir: string, patch: CliConfig): CliConfig {
	const next: CliConfig = { ...loadCliConfig(dir) };
	if (patch.url !== undefined) next.url = patch.url.replace(/\/+$/, '');
	if (patch.api_key !== undefined) next.api_key = patch.api_key;
	writeJsonFile(configPath(dir), next, { secret: true });
	return next;
}

/** Deletes the config file. Returns false when there was none. */
export function clearCliConfig(dir: string = defaultConfigDir()): boolean {
	const path = configPath(dir);
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}
