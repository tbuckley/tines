/**
 * Runner identity: the one place a runner registers or reconnects, shared by
 * `tines runner daemon` (which does it on every start) and `tines runner
 * install` (which does it once, before writing the service unit). Keeping it
 * in one function is what guarantees the service and the foreground daemon
 * never disagree about which token, name or URL a runner is.
 *
 * The user API key is consumed here and nowhere else: it registers the
 * runner, the supervisor hands back a long-lived runner token, and that token
 * is what gets stored (`runners.json`, keyed by URL and name). Later starts
 * find the token and never touch the key — which is why a service unit needs
 * no credential in it.
 */
import { arch, hostname, platform } from 'node:os';
import { createApiClient } from '@tines/shared';
import { loadRunnerCredentials, saveRunnerCredentials, type RunnerCredentials } from './store.js';
import type { HarnessKind } from './support.js';

export interface RegisterRunnerOptions {
	configDir: string;
	/** Trailing slashes already stripped. */
	baseUrl: string;
	name: string;
	harness: HarnessKind;
	command?: string;
	maxConcurrent: number;
	/** User API key — only consulted when no token is stored for this runner. */
	apiKey?: string;
	log: (message: string) => void;
}

export interface EnsuredRunner {
	creds: RunnerCredentials;
	/** True when this call registered the runner; false when it reconnected. */
	registered: boolean;
}

/** The error a start without a stored token and without a key gets. */
export function missingApiKeyMessage(name: string, baseUrl: string): string {
	return `no stored runner token for "${name}" at ${baseUrl} — set TINES_API_KEY (a user API key) to register`;
}

/**
 * Loads the stored token for this URL and name, or registers with the user
 * API key and stores the token the supervisor returns. Throws when neither
 * is possible.
 */
export async function ensureRunnerCredentials(opts: RegisterRunnerOptions): Promise<EnsuredRunner> {
	const stored = loadRunnerCredentials(opts.configDir, opts.baseUrl, opts.name);
	if (stored) {
		opts.log(
			`reconnecting as runner "${opts.name}" (${stored.runner_id}) — token from ${opts.configDir}`
		);
		return { creds: stored, registered: false };
	}
	if (!opts.apiKey) throw new Error(missingApiKeyMessage(opts.name, opts.baseUrl));
	const userClient = createApiClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });
	const registered = await userClient.registerRunner({
		name: opts.name,
		harness: opts.harness,
		...(opts.command !== undefined ? { command: opts.command } : {}),
		max_concurrent: opts.maxConcurrent,
		hostname: hostname(),
		platform: `${platform()} ${arch()}`
	});
	const creds = { runner_id: registered.runner.id, token: registered.runner_token };
	saveRunnerCredentials(opts.configDir, opts.baseUrl, opts.name, creds);
	opts.log(
		`registered runner "${opts.name}" (${creds.runner_id}); token stored in ${opts.configDir}`
	);
	return { creds, registered: true };
}

/** The "what now" line printed after a first registration. */
export function nextStepsMessage(name: string, baseUrl: string): string {
	return `next: route work to "${name}" — ${baseUrl}/agents (or: tines routing set ${name}). Eligible work starts when this runner is available and routing matches. If automation is stopped, resume it in Agents or with tines supervisor enable.`;
}
