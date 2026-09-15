/**
 * `tines runner install` / `restart` / `uninstall`: the runner as a service.
 *
 * The daemon only keeps itself current when it is launched from the managed
 * prefix under a service manager (see daemon.ts "self-update" and
 * docs/runner-daemon.md "Keeping the daemon itself current"). Hand-writing
 * the unit for that is where every stale runner has come from: a daemon
 * started from a terminal, a global install or a source checkout runs the
 * same binary forever. This module is the pure half of doing it for the
 * user — what the unit says, what PATH it gets, which processes count as an
 * already-running daemon, and which service-manager commands load, restart
 * and unload it. The I/O (writing files, spawning `launchctl`/`systemctl`,
 * tailing the log) lives in commands/runner-service.ts.
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join, sep } from 'node:path';

export type ServiceManagerKind = 'launchd' | 'systemd';

/** The service manager this platform ships, or null where there is none. */
export function defaultServiceManager(
	platform: string = process.platform
): ServiceManagerKind | null {
	if (platform === 'darwin') return 'launchd';
	if (platform === 'linux') return 'systemd';
	return null;
}

/**
 * A runner name is a CLI address (`RUNNER_NAME_PATTERN`: letters, digits,
 * `.`, `_`, `-`), so it is safe verbatim in a launchd label, a unit name and
 * a file name.
 */
export function serviceLabel(name: string, kind: ServiceManagerKind): string {
	return kind === 'launchd' ? `dev.tines.runner.${name}` : `tines-runner-${name}`;
}

/** Where the unit file lives: per-user, never system-wide. */
export function unitPath(name: string, kind: ServiceManagerKind, home: string): string {
	const label = serviceLabel(name, kind);
	return kind === 'launchd'
		? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
		: join(home, '.config', 'systemd', 'user', `${label}.service`);
}

/** The daemon's console output under the service; also what `install` tails. */
export function serviceLogPath(configDir: string, name: string): string {
	return join(configDir, 'logs', `runner-${name}.log`);
}

/** The daemon-managed binary the unit must launch, for self-update to act. */
export function managedBinary(prefix: string): string {
	return join(prefix, 'node_modules', '.bin', 'tines');
}

export interface DaemonArgsInput {
	url: string;
	name: string;
	/** As the CLI spells it: `claude-code`, `codex`, `custom`. */
	harness: string;
	command?: string;
	maxConcurrent: number;
	allowRemoteConcurrency?: boolean;
	pollIntervalSeconds?: number;
	keepWorkspaces?: string;
	keepWorkspacesForHours?: number;
	keepWorkspacesMax?: number;
}

/**
 * The daemon's argv after the binary. Only what differs from the daemon's
 * defaults is written, so a unit reads like the command a person would type.
 * The API key is never here: registration happens before the unit is
 * written, and the daemon reconnects with the stored token.
 */
export function daemonArgs(input: DaemonArgsInput): string[] {
	const args = [
		'runner',
		'daemon',
		'--url',
		input.url,
		'--name',
		input.name,
		'--harness',
		input.harness
	];
	if (input.command !== undefined) args.push('--command', input.command);
	if (input.maxConcurrent !== 1) args.push('--max-concurrent', String(input.maxConcurrent));
	if (input.allowRemoteConcurrency) args.push('--allow-remote-concurrency');
	if (input.pollIntervalSeconds !== undefined && input.pollIntervalSeconds !== 15)
		args.push('--poll-interval', String(input.pollIntervalSeconds));
	if (input.keepWorkspaces !== undefined && input.keepWorkspaces !== 'never')
		args.push('--keep-workspaces', input.keepWorkspaces);
	if (input.keepWorkspacesForHours !== undefined && input.keepWorkspacesForHours !== 72)
		args.push('--keep-workspaces-for', String(input.keepWorkspacesForHours));
	if (input.keepWorkspacesMax !== undefined && input.keepWorkspacesMax !== 20)
		args.push('--keep-workspaces-max', String(input.keepWorkspacesMax));
	return args;
}

/** First directory on `envPath` holding an executable file called `name`. */
export function findOnPath(name: string, envPath: string | undefined): string | null {
	for (const dir of (envPath ?? '').split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Not here.
		}
	}
	return null;
}

export interface ServicePathInput {
	/** The node running this command: the daemon runs under the same one. */
	execPath: string;
	/** Executables the harness needs, resolved on the current PATH. */
	required: string[];
	envPath: string | undefined;
	platform: string;
}

/**
 * A service manager starts the daemon with a minimal PATH, so the unit names
 * every directory the daemon and its harness need: where `node` lives (an
 * nvm/Volta/Homebrew node is nowhere near `/usr/bin`), where each required
 * executable was found on the caller's PATH, then the platform's usual bins.
 * Order is kept, duplicates dropped, so the unit's PATH stays readable.
 */
export function servicePath(input: ServicePathInput): { path: string; missing: string[] } {
	const dirs: string[] = [dirname(input.execPath)];
	const missing: string[] = [];
	for (const name of input.required) {
		const found = findOnPath(name, input.envPath);
		if (found) dirs.push(dirname(found));
		else missing.push(name);
	}
	dirs.push(
		...(input.platform === 'darwin'
			? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']
			: ['/usr/local/bin', '/usr/bin', '/bin'])
	);
	return { path: [...new Set(dirs)].join(delimiter), missing };
}

export interface ServiceSpec {
	name: string;
	kind: ServiceManagerKind;
	/** The managed-prefix binary. */
	binary: string;
	args: string[];
	path: string;
	logPath: string;
	/** Extra environment for the daemon (a custom `TINES_CONFIG_DIR`, say). */
	env: Record<string, string>;
}

function xml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * The launchd unit. `KeepAlive` is load-bearing, not a nicety: the daemon
 * exits on purpose once idle after a newer release lands in the prefix, and
 * launchd relaunching it is the whole self-update mechanism.
 */
export function renderLaunchdPlist(spec: ServiceSpec): string {
	const label = serviceLabel(spec.name, 'launchd');
	const env = { PATH: spec.path, ...spec.env };
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		'<dict>',
		`\t<key>Label</key><string>${xml(label)}</string>`,
		'\t<key>ProgramArguments</key>',
		'\t<array>',
		...[spec.binary, ...spec.args].map((arg) => `\t\t<string>${xml(arg)}</string>`),
		'\t</array>',
		'\t<key>EnvironmentVariables</key>',
		'\t<dict>',
		...Object.entries(env).map(
			([key, value]) => `\t\t<key>${xml(key)}</key><string>${xml(value)}</string>`
		),
		'\t</dict>',
		'\t<key>RunAtLoad</key><true/>',
		"\t<!-- Relaunches after any exit: a crash, and the daemon's own exit for a self-update. -->",
		'\t<key>KeepAlive</key><true/>',
		`\t<key>StandardOutPath</key><string>${xml(spec.logPath)}</string>`,
		`\t<key>StandardErrorPath</key><string>${xml(spec.logPath)}</string>`,
		'</dict>',
		'</plist>',
		''
	];
	return lines.join('\n');
}

/** systemd's ExecStart quoting: double quotes, with backslash and quote escaped. */
function unitQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@%+-]+$/.test(value)
		? value
		: `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * The systemd user unit. `Restart=always` rather than `on-failure` for the
 * same reason as launchd's KeepAlive: a self-update exit is code 0.
 */
export function renderSystemdUnit(spec: ServiceSpec): string {
	const env = { PATH: spec.path, ...spec.env };
	const lines = [
		'[Unit]',
		`Description=Tines local runner daemon (${spec.name})`,
		'After=network-online.target',
		'',
		'[Service]',
		`ExecStart=${[spec.binary, ...spec.args].map(unitQuote).join(' ')}`,
		...Object.entries(env).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`),
		`StandardOutput=append:${spec.logPath}`,
		`StandardError=append:${spec.logPath}`,
		'# always, not on-failure: the daemon exits 0 on purpose to pick up a self-update.',
		'Restart=always',
		'RestartSec=10',
		'',
		'[Install]',
		'WantedBy=default.target',
		''
	];
	return lines.join('\n');
}

export function renderUnit(spec: ServiceSpec): string {
	return spec.kind === 'launchd' ? renderLaunchdPlist(spec) : renderSystemdUnit(spec);
}

export interface ServiceCommand {
	argv: string[];
	/** A step that is allowed to fail: unloading what is not loaded, say. */
	optional?: boolean;
}

export interface ServiceTarget {
	kind: ServiceManagerKind;
	name: string;
	unitPath: string;
	/** launchd's domain needs the uid; systemd's `--user` does not. */
	uid: number;
}

/** The service-manager invocations, in order, for each operation. */
export function serviceCommands(
	target: ServiceTarget
): Record<'load' | 'restart' | 'unload', ServiceCommand[]> {
	const label = serviceLabel(target.name, target.kind);
	if (target.kind === 'launchd') {
		const domain = `gui/${target.uid}`;
		return {
			// bootout first so a re-install replaces the loaded definition
			// instead of failing with "service already loaded".
			load: [
				{ argv: ['launchctl', 'bootout', `${domain}/${label}`], optional: true },
				{ argv: ['launchctl', 'bootstrap', domain, target.unitPath] }
			],
			restart: [{ argv: ['launchctl', 'kickstart', '-k', `${domain}/${label}`] }],
			unload: [{ argv: ['launchctl', 'bootout', `${domain}/${label}`], optional: true }]
		};
	}
	return {
		load: [
			{ argv: ['systemctl', '--user', 'daemon-reload'] },
			{ argv: ['systemctl', '--user', 'enable', '--now', label] },
			// So the runner keeps working while nobody is logged in.
			{ argv: ['loginctl', 'enable-linger'], optional: true }
		],
		restart: [{ argv: ['systemctl', '--user', 'restart', label] }],
		unload: [
			{ argv: ['systemctl', '--user', 'disable', '--now', label], optional: true },
			{ argv: ['systemctl', '--user', 'daemon-reload'], optional: true }
		]
	};
}

export interface DaemonProcess {
	pid: number;
	args: string;
	/** Launched from the managed prefix, i.e. by the service this tool wrote. */
	managed: boolean;
}

export interface DaemonProcessQuery {
	name: string;
	/** What an unnamed daemon (`--name` omitted) is called. */
	hostname: string;
	/** The managed prefix; a daemon whose argv lies inside it is ours. */
	prefix: string;
	selfPid: number;
}

/**
 * Which `tines runner daemon` processes in `ps -axo pid=,args=` output belong
 * to this runner name. The one already-running case `install` must refuse is
 * a daemon started some other way — a terminal, a global install, a source
 * checkout — because loading a service beside it would run the runner twice
 * and the old one would go on holding its stale binary.
 */
export function matchDaemonProcesses(psOutput: string, query: DaemonProcessQuery): DaemonProcess[] {
	const matches: DaemonProcess[] = [];
	for (const raw of psOutput.split('\n')) {
		const line = raw.trim();
		const m = /^(\d+)\s+(.*)$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		const args = m[2]!;
		if (pid === query.selfPid) continue;
		const words = args.split(/\s+/);
		const daemonAt = words.findIndex((w, i) => w === 'runner' && words[i + 1] === 'daemon');
		if (daemonAt < 0) continue;
		const binary = words[daemonAt - 1] ?? '';
		// A `tines` binary, or node running one: not some unrelated program
		// that happens to take `runner daemon` as arguments.
		if (!/(^|\/)tines(\.js|\.cjs|\.mjs)?$/.test(binary) && !/(^|\/)tines$/.test(binary)) continue;
		let name: string | null = null;
		for (let i = daemonAt + 2; i < words.length; i++) {
			const w = words[i]!;
			if (w === '--name') name = words[i + 1] ?? null;
			else if (w.startsWith('--name=')) name = w.slice('--name='.length);
		}
		if ((name ?? query.hostname) !== query.name) continue;
		const root = query.prefix.endsWith(sep) ? query.prefix : query.prefix + sep;
		matches.push({ pid, args, managed: args.includes(root) });
	}
	return matches;
}

/** The daemon's own reconnect/register line, as it appears in its log. */
export function daemonStartedLine(name: string): RegExp {
	const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(reconnecting as runner|registered runner) "${escaped}"`);
}

/** Whether the managed prefix holds a launchable `tines`. */
export function managedBinaryPresent(prefix: string): boolean {
	return existsSync(managedBinary(prefix));
}
