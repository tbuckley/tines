/**
 * The flags `tines runner daemon` and `tines runner install` share, declared
 * and validated once: the unit `install` writes must mean exactly what the
 * same flags mean on a foreground start.
 */
import { hostname } from 'node:os';
import type { Command } from 'commander';
import { die } from '../common.js';
import {
	HARNESS_KINDS,
	KEEP_WORKSPACES_MODES,
	type HarnessKind,
	type KeepWorkspacesMode
} from '../daemon/support.js';

export interface DaemonFlagValues {
	name?: string;
	harness: string;
	command?: string;
	maxConcurrent: number;
	allowRemoteConcurrency?: boolean;
	pollInterval: number;
	keepWorkspaces: string;
	keepWorkspacesFor: number;
	keepWorkspacesMax: number;
}

export interface DaemonSettings {
	name: string;
	harness: HarnessKind;
	command?: string;
	maxConcurrent: number;
	allowRemoteConcurrency: boolean;
	pollIntervalSeconds: number;
	keepWorkspaces: KeepWorkspacesMode;
	keepWorkspacesForHours: number;
	keepWorkspacesMax: number;
}

export function withDaemonFlags(cmd: Command): Command {
	return cmd
		.option(
			'--name <name>',
			'runner name, unique per user; name it machine-plus-harness, e.g. macbook-claude (default: this hostname)'
		)
		.option('--harness <harness>', 'claude-code | codex | custom', 'claude-code')
		.option(
			'--command <template>',
			'custom harness command template ({prompt_file}, {workspace}, {model})'
		)
		.option(
			'--max-concurrent <n>',
			'local maximum simultaneous runs (remote-adjustment ceiling when enabled)',
			(v) => Number(v),
			1
		)
		.option(
			'--allow-remote-concurrency',
			'allow signed-in operators to request concurrency up to --max-concurrent'
		)
		.option('--poll-interval <seconds>', 'seconds between polls', (v) => Number.parseInt(v, 10), 15)
		.option(
			'--keep-workspaces <mode>',
			"keep settled runs' workspaces for debugging: never | failed | always",
			'never'
		)
		.option(
			'--keep-workspaces-for <hours>',
			'delete kept workspaces older than this',
			(v) => Number(v),
			72
		)
		.option(
			'--keep-workspaces-max <n>',
			'keep at most this many workspaces (oldest removed first)',
			(v) => Number.parseInt(v, 10),
			20
		);
}

/** Validates the shared flags; exits with the daemon's usual messages when they are wrong. */
export function parseDaemonFlags(opts: DaemonFlagValues): DaemonSettings {
	const harness = opts.harness.replaceAll('-', '_') as HarnessKind;
	if (!HARNESS_KINDS.includes(harness)) {
		die(`--harness must be claude-code, codex, or custom, got "${opts.harness}"`);
	}
	if (harness === 'custom' && !opts.command) {
		die('the custom harness needs --command "<template>" ({prompt_file}, {workspace}, {model})');
	}
	if (harness !== 'custom' && opts.command) die('--command only applies to --harness custom');
	if (!Number.isInteger(opts.maxConcurrent) || opts.maxConcurrent < 1 || opts.maxConcurrent > 100) {
		die('--max-concurrent must be an integer between 1 and 100');
	}
	if (!Number.isInteger(opts.pollInterval) || opts.pollInterval < 1) {
		die('--poll-interval must be a positive number of seconds');
	}
	const keepWorkspaces = opts.keepWorkspaces as KeepWorkspacesMode;
	if (!KEEP_WORKSPACES_MODES.includes(keepWorkspaces)) {
		die(
			`--keep-workspaces must be ${KEEP_WORKSPACES_MODES.join(', ')}, got "${opts.keepWorkspaces}"`
		);
	}
	if (!Number.isFinite(opts.keepWorkspacesFor) || opts.keepWorkspacesFor <= 0) {
		die('--keep-workspaces-for must be a positive number of hours');
	}
	if (!Number.isInteger(opts.keepWorkspacesMax) || opts.keepWorkspacesMax < 1) {
		die('--keep-workspaces-max must be a positive integer');
	}
	return {
		name: opts.name ?? hostname(),
		harness,
		...(opts.command !== undefined ? { command: opts.command } : {}),
		maxConcurrent: opts.maxConcurrent,
		allowRemoteConcurrency: opts.allowRemoteConcurrency === true,
		pollIntervalSeconds: opts.pollInterval,
		keepWorkspaces,
		keepWorkspacesForHours: opts.keepWorkspacesFor,
		keepWorkspacesMax: opts.keepWorkspacesMax
	};
}

/** The harness as the CLI spells it (`claude-code`), for a command line. */
export function harnessFlag(harness: HarnessKind): string {
	return harness.replaceAll('_', '-');
}
