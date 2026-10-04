/**
 * `tines runner install` / `restart` / `uninstall` — the runner as a
 * service, in one command instead of the hand-written unit
 * docs/runner-daemon.md used to ask for. The pure half (what the unit says,
 * which processes count as already running, which service-manager commands
 * apply) is daemon/service.ts; this file is the I/O around it.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import {
	die,
	printJson,
	resolveApiKey,
	resolveUrl,
	withCommon,
	type CommonOpts
} from '../common.js';
import { agentCliPrefix, installAgentCli } from '../daemon/cli-refresh.js';
import { PI_VERSION_FLOOR, piVersionSupported } from '../daemon/effort-capabilities.js';
import { ensureRunnerCredentials, nextStepsMessage } from '../daemon/register.js';
import {
	daemonArgs,
	daemonStartedLine,
	defaultServiceManager,
	findOnPath,
	listedPiModels,
	managedBinary,
	managedBinaryPresent,
	matchDaemonProcesses,
	renderUnit,
	serviceCommands,
	serviceLabel,
	serviceLogPath,
	servicePath,
	unitPath,
	type ServiceCommand,
	type ServiceManagerKind,
	type ServiceSpec
} from '../daemon/service.js';
import { defaultConfigDir } from '../daemon/store.js';
import type { HarnessKind } from '../daemon/support.js';
import {
	harnessFlag,
	parseDaemonFlags,
	withDaemonFlags,
	type DaemonFlagValues
} from './daemon-flags.js';

const run = promisify(execFile);

/** How long `install` waits for the service-launched daemon to report in. */
const STARTUP_TIMEOUT_MS = 30_000;

const log = (message: string) => console.log(message);

/** The binary each harness needs on the service's PATH; `custom` names its own. */
const HARNESS_BINARIES: Record<HarnessKind, string | null> = {
	claude_code: 'claude',
	codex: 'codex',
	pi: 'pi',
	custom: null
};

function resolveServiceManager(flag: string | undefined): ServiceManagerKind {
	if (flag !== undefined) {
		if (flag !== 'launchd' && flag !== 'systemd')
			die(`--service-manager must be launchd or systemd, got "${flag}"`);
		return flag;
	}
	const kind = defaultServiceManager();
	if (!kind) {
		die(
			`no service manager is known for ${process.platform}; run \`tines runner daemon\` under your own supervisor instead`
		);
	}
	return kind;
}

/** Runs the service manager steps in order; a required step's failure is fatal. */
async function runServiceCommands(steps: ServiceCommand[]): Promise<void> {
	for (const step of steps) {
		try {
			await run(step.argv[0]!, step.argv.slice(1), { timeout: 30_000 });
		} catch (err) {
			if (step.optional) continue;
			const detail =
				err && typeof err === 'object' && 'stderr' in err && String(err.stderr).trim()
					? `: ${String(err.stderr).trim()}`
					: err instanceof Error
						? `: ${err.message}`
						: '';
			die(`\`${step.argv.join(' ')}\` failed${detail}`);
		}
	}
}

/** `ps` output for the running-daemon check, or null where `ps` is unavailable. */
async function listProcesses(): Promise<string | null> {
	try {
		const { stdout } = await run('ps', ['-axo', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 });
		return stdout;
	} catch {
		return null;
	}
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Waits for the daemon's own start line to land in the log after `offset`. */
async function waitForStart(logPath: string, offset: number, name: string): Promise<boolean> {
	const pattern = daemonStartedLine(name);
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (existsSync(logPath)) {
			const content = readFileSync(logPath, 'utf8').slice(offset);
			if (pattern.test(content)) return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return false;
}

/**
 * The Pi preflight, run against the `pi` the service's PATH resolves to —
 * the one the daemon will launch, which is not always this shell's first.
 * Too old is fatal before anything is registered or written: the daemon
 * cannot parse its stream. Returns whether a `pi` was there to check; when
 * it is not, the missing-binary warning covers it.
 */
async function requirePiVersion(path: string): Promise<boolean> {
	const pi = findOnPath('pi', path);
	if (!pi) return false;
	let version: string;
	try {
		version = (await run(pi, ['--version'], { timeout: 10_000 })).stdout.trim();
	} catch (err) {
		die(`\`${pi} --version\` failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!piVersionSupported(version)) {
		die(
			`${pi} is pi ${version || '(unknown version)'}, older than ${PI_VERSION_FLOOR}, the oldest the pi harness supports — update it (\`npm install -g @earendil-works/pi-coding-agent\`), then install again`
		);
	}
	return true;
}

/**
 * Asks `pi` for its models the way the service will: the unit's PATH and
 * HOME, and none of this shell's other variables. Credentials that depend
 * on one (an API key exported in a shell profile) show up here as an empty
 * list, which is what the daemon would see on every run.
 */
async function warnIfPiListsNoModels(path: string): Promise<void> {
	let count: number;
	try {
		const { stdout } = await run('pi', ['--list-models'], {
			env: { PATH: path, HOME: homedir() },
			timeout: 30_000
		});
		count = listedPiModels(stdout);
	} catch (err) {
		log(
			`warning: could not run \`pi --list-models\` with the service's PATH (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); check the model list yourself before routing work here`
		);
		return;
	}
	if (count > 0) {
		log(`pi lists ${count} model${count === 1 ? '' : 's'} in the service's environment`);
		return;
	}
	log(
		'warning: `pi --list-models` lists no models in the service\'s environment. The service gets only PATH and HOME, not this shell\'s variables, so model credentials that depend on one (an API key exported in your shell profile) are invisible to it and every run would fail. Put the credential where pi reads it without the shell (`~/.pi/agent/auth.json`, or a literal key in `~/.pi/agent/models.json`), then `tines runner restart`. See docs/runner-daemon.md, "Pi" → "Model credentials".'
	);
}

function serviceTarget(name: string, kind: ServiceManagerKind) {
	return { kind, name, unitPath: unitPath(name, kind, homedir()), uid: userInfo().uid };
}

export function registerServiceCommands(runnerCmd: Command): void {
	withCommon(
		withDaemonFlags(
			runnerCmd
				.command('install')
				.description(
					'Register this machine as a runner and install the daemon as a launchd/systemd service that keeps itself updated'
				)
		).option('--service-manager <kind>', 'launchd | systemd (default: the one this OS ships)')
	).action(async (opts: CommonOpts & DaemonFlagValues & { serviceManager?: string }) => {
		const settings = parseDaemonFlags(opts);
		const kind = resolveServiceManager(opts.serviceManager);
		const baseUrl = resolveUrl(opts).replace(/\/+$/, '');
		const configDir = defaultConfigDir();
		mkdirSync(configDir, { recursive: true });
		const prefix = agentCliPrefix(configDir);

		// A daemon for this name that is already running — from a terminal,
		// a global install, a source checkout, or this very service — must
		// be stopped first: loading a service beside it would run the
		// runner twice, and the old one would keep its stale binary.
		const ps = await listProcesses();
		const running = ps
			? matchDaemonProcesses(ps, {
					name: settings.name,
					hostname: hostname(),
					prefix,
					selfPid: process.pid
				})
			: [];
		if (running.length > 0) {
			const label = serviceLabel(settings.name, kind);
			const lines = running.map((p) => `  pid ${p.pid}: ${p.args}`);
			die(
				running.every((p) => p.managed)
					? `"${settings.name}" is already running under its service (${label}):\n${lines.join('\n')}\nto change its flags: \`tines runners pause ${settings.name}\`, wait for 0 active runs, \`tines runner uninstall ${settings.name}\`, then install again — or \`tines runner restart ${settings.name}\` to relaunch it as is`
					: `a daemon for "${settings.name}" is already running outside the service:\n${lines.join('\n')}\nstop it first — \`tines runners pause ${settings.name}\`, wait for 0 active runs, kill that process — then run install again; it reconnects with the stored token, so no key is needed`
			);
		}

		const harnessBinary = HARNESS_BINARIES[settings.harness];
		const { path, missing } = servicePath({
			execPath: process.execPath,
			required: [...(harnessBinary ? [harnessBinary] : []), 'git'],
			envPath: process.env.PATH,
			platform: process.platform
		});
		const piPresent = settings.harness === 'pi' && (await requirePiVersion(path));

		// The managed prefix: the binary the unit launches, so that a newer
		// release installed there restarts the daemon (self-update).
		if (!managedBinaryPresent(prefix)) {
			log(`installing the daemon-managed tines into ${prefix} …`);
			await installAgentCli({ configDir, log });
			if (!managedBinaryPresent(prefix)) {
				die(
					`could not install tines into ${prefix}; the service needs that copy (npm and network access required)`
				);
			}
		}

		// Identity: consumes the API key on a first registration; a stored
		// token means a reconnect and no key at all.
		let ensured;
		try {
			ensured = await ensureRunnerCredentials({
				configDir,
				baseUrl,
				name: settings.name,
				harness: settings.harness,
				...(settings.command !== undefined ? { command: settings.command } : {}),
				maxConcurrent: settings.maxConcurrent,
				allowRemoteConcurrency: settings.allowRemoteConcurrency,
				...(resolveApiKey(opts) !== undefined ? { apiKey: resolveApiKey(opts) } : {}),
				log
			});
		} catch (err) {
			die(err instanceof Error ? err.message : String(err));
		}

		for (const name of missing) {
			log(
				`warning: \`${name}\` is not on this shell's PATH, so it is not on the service's either — install it, then \`tines runner install\` again`
			);
		}

		if (piPresent) await warnIfPiListsNoModels(path);

		const target = serviceTarget(settings.name, kind);
		const logPath = serviceLogPath(configDir, settings.name);
		const spec: ServiceSpec = {
			name: settings.name,
			kind,
			binary: managedBinary(prefix),
			args: daemonArgs({
				url: baseUrl,
				name: settings.name,
				harness: harnessFlag(settings.harness),
				...(settings.command !== undefined ? { command: settings.command } : {}),
				maxConcurrent: settings.maxConcurrent,
				allowRemoteConcurrency: settings.allowRemoteConcurrency,
				pollIntervalSeconds: settings.pollIntervalSeconds,
				keepWorkspaces: settings.keepWorkspaces,
				keepWorkspacesForHours: settings.keepWorkspacesForHours,
				keepWorkspacesMax: settings.keepWorkspacesMax
			}),
			path,
			logPath,
			env: process.env.TINES_CONFIG_DIR ? { TINES_CONFIG_DIR: process.env.TINES_CONFIG_DIR } : {}
		};
		mkdirSync(dirname(target.unitPath), { recursive: true });
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(target.unitPath, renderUnit(spec), { mode: 0o644 });
		log(`wrote ${target.unitPath}`);

		const offset = fileSize(logPath);
		await runServiceCommands(serviceCommands(target).load);
		log(`loaded ${serviceLabel(settings.name, kind)}; waiting for the daemon to report in …`);
		const started = await waitForStart(logPath, offset, settings.name);
		const summary = {
			name: settings.name,
			runner_id: ensured.creds.runner_id,
			registered: ensured.registered,
			service_manager: kind,
			unit_path: target.unitPath,
			log_path: logPath,
			started
		};
		if (!started) {
			if (opts.json) printJson(summary);
			die(
				`the service is loaded but the daemon has not reported in after ${STARTUP_TIMEOUT_MS / 1000}s — read ${logPath} (a missing \`node\` on the service PATH, or a rejected token, shows there)`
			);
		}
		if (opts.json) return printJson(summary);
		log(
			`runner "${settings.name}" is up under ${kind} and updates itself: log at ${logPath}; \`tines runner restart ${settings.name}\` relaunches it, \`tines runner uninstall ${settings.name}\` removes the service`
		);
		if (ensured.registered) log(nextStepsMessage(settings.name, baseUrl));
	});

	runnerCmd
		.command('restart [name]')
		.description(
			'Relaunch an installed runner service (interrupts runs in flight: pause the runner and wait for 0 active runs first if that matters)'
		)
		.option('--service-manager <kind>', 'launchd | systemd (default: the one this OS ships)')
		.option('--json', 'print JSON instead of a message')
		.action(async (name: string | undefined, opts: { serviceManager?: string; json?: boolean }) => {
			const kind = resolveServiceManager(opts.serviceManager);
			const target = serviceTarget(name ?? hostname(), kind);
			if (!existsSync(target.unitPath)) {
				die(
					`"${target.name}" is not installed as a service (no ${target.unitPath}); run \`tines runner install --name ${target.name} …\` first`
				);
			}
			await runServiceCommands(serviceCommands(target).restart);
			if (opts.json)
				return printJson({ name: target.name, service_manager: kind, restarted: true });
			log(`restarted ${serviceLabel(target.name, kind)}`);
		});

	runnerCmd
		.command('uninstall [name]')
		.description(
			"Stop and remove a runner's service unit (the stored runner token is kept, so a later install reconnects)"
		)
		.option('--service-manager <kind>', 'launchd | systemd (default: the one this OS ships)')
		.option('--json', 'print JSON instead of a message')
		.action(async (name: string | undefined, opts: { serviceManager?: string; json?: boolean }) => {
			const kind = resolveServiceManager(opts.serviceManager);
			const target = serviceTarget(name ?? hostname(), kind);
			const existed = existsSync(target.unitPath);
			await runServiceCommands(serviceCommands(target).unload);
			rmSync(target.unitPath, { force: true });
			if (opts.json)
				return printJson({ name: target.name, service_manager: kind, removed: existed });
			log(
				existed
					? `removed ${serviceLabel(target.name, kind)} (${target.unitPath}); the runner token is still stored, so \`tines runner install\` reconnects without a key`
					: `no service unit for "${target.name}" at ${target.unitPath}; nothing to remove`
			);
		});
}
