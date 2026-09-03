/**
 * `tines login`, `tines logout`, and `tines config`: the stored API URL and
 * key for this machine, so a human does not have to export TINES_API_URL and
 * TINES_API_KEY in every shell. Resolution order is flag, env var, stored
 * config, default (see common.ts); `config` shows which one is in effect.
 */
import { readFileSync } from 'node:fs';
import { ApiError, createApiClient } from '@tines/shared';
import type { Command } from 'commander';
import {
	DEFAULT_URL,
	die,
	printJson,
	resolveApiKeySetting,
	resolveUrlSetting,
	withCommon,
	type CommonOpts
} from '../common.js';
import { clearCliConfig, configPath, defaultConfigDir, saveCliConfig } from '../config.js';

/** The first 14 characters, matching the `key_prefix` the web app shows. */
function maskKey(key: string): string {
	return `${key.slice(0, 14)}…`;
}

function readKeyArg(value: string): string {
	if (value !== '-') return value;
	// `--api-key -` keeps the secret out of shell history.
	const key = readFileSync(0, 'utf8').trim();
	if (!key) die('no API key on stdin');
	return key;
}

export function register(program: Command): void {
	program
		.command('login')
		.description('Store the API URL and key for this machine, so commands need no env vars')
		.option('-u, --url <url>', `base URL of the Tines API to store (default ${DEFAULT_URL})`)
		.option('--api-key <key>', 'API key from Settings → API keys ("-" reads it from stdin)')
		.option('--no-verify', 'store without checking the key against the API')
		.action(async (opts: { url?: string; apiKey?: string; verify: boolean }) => {
			if (!opts.url && !opts.apiKey) die('pass --url and/or --api-key');
			const dir = defaultConfigDir();
			const apiKey = opts.apiKey ? readKeyArg(opts.apiKey) : undefined;

			// Check the pair that will be in effect after saving, not just the
			// flags given: a new key against a previously stored URL, or vice
			// versa, is exactly the combination that needs verifying.
			const url = (opts.url ?? resolveUrlSetting({}).value ?? DEFAULT_URL).replace(/\/+$/, '');
			const key = apiKey ?? resolveApiKeySetting({}).value;
			if (opts.verify && key) {
				try {
					await createApiClient({ baseUrl: url, apiKey: key }).listProjects({ limit: 1 });
				} catch (err) {
					if (err instanceof ApiError && err.status === 401) {
						die(`${url} rejected the API key (${err.message}); nothing stored`);
					}
					if (err instanceof ApiError) throw err;
					// Network failure: fetch's own message is just "fetch failed".
					const cause = (err as { cause?: { code?: string } }).cause?.code;
					die(
						`could not reach ${url}${cause ? ` (${cause})` : ''}; nothing stored (pass --no-verify to store anyway)`
					);
				}
			}

			const stored = saveCliConfig(dir, { url: opts.url, api_key: apiKey });
			console.log(`stored in ${configPath(dir)}`);
			console.log(`url: ${stored.url ?? `${DEFAULT_URL} (default)`}`);
			console.log(`api key: ${stored.api_key ? maskKey(stored.api_key) : 'none'}`);
		});

	program
		.command('logout')
		.description('Forget the stored API URL and key')
		.action(() => {
			const dir = defaultConfigDir();
			console.log(
				clearCliConfig(dir) ? `removed ${configPath(dir)}` : `nothing stored in ${configPath(dir)}`
			);
		});

	// withCommon: the same three flags every API command takes, so `config`
	// reports exactly what a command given the same flags would use.
	withCommon(
		program
			.command('config')
			.description('Show the API URL and key in effect, and where each comes from')
	).action((opts: CommonOpts) => {
		const url = resolveUrlSetting(opts);
		const key = resolveApiKeySetting(opts);
		const report = {
			url: { value: url.value, source: url.source },
			api_key: {
				value: key.value ? maskKey(key.value) : null,
				source: key.value || key.source === 'proxy' ? key.source : null
			},
			config_path: configPath(defaultConfigDir())
		};
		if (opts.json) return printJson(report);
		console.log(`url: ${report.url.value} (${report.url.source})`);
		console.log(
			report.api_key.value
				? `api key: ${report.api_key.value} (${report.api_key.source})`
				: report.api_key.source === 'proxy'
					? 'api key: none — the config file says an egress proxy injects it (proxy)'
					: 'api key: none (pass --api-key, set TINES_API_KEY, or run `tines login`)'
		);
		console.log(`config file: ${report.config_path}`);
	});
}
