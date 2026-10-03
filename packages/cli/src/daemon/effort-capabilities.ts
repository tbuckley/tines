import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
	admitEffort,
	EFFORT_CAPABILITIES_MAX_MODELS,
	isRecognizedEffort,
	supportedEfforts,
	type EffortCapabilities,
	type EffortCapabilitiesV1,
	type RunnerAssignment
} from '@tines/shared';
import type { HarnessKind } from './support.js';

const MAX_STDOUT = 1024 * 1024;
const DEADLINE_MS = 5000;
export const EFFORT_CAPABILITIES_TTL_MS = 10 * 60_000;
const MIN_CLAUDE_EFFORT_VERSION = [2, 1, 258] as const;
/** The `pi` whose JSON event and RPC shapes this daemon parses (Tines/900). */
const MIN_PI_VERSION = [0, 99, 2] as const;
/** The same floor, as `tines runner install` names it. */
export const PI_VERSION_FLOOR = MIN_PI_VERSION.join('.');
/** One RPC round trip per model, so Pi's probe gets longer than the others. */
const PI_DEADLINE_MS = 20_000;

function versionAtLeast(version: string, floor: readonly number[]): boolean {
	const parsed = version
		.match(/(\d+)\.(\d+)\.(\d+)/)
		?.slice(1)
		.map(Number);
	if (!parsed) return false;
	for (let i = 0; i < floor.length; i++) {
		if (parsed[i]! > floor[i]!) return true;
		if (parsed[i]! < floor[i]!) return false;
	}
	return true;
}

export function claudeEffortVersionSupported(version: string): boolean {
	return versionAtLeast(version, MIN_CLAUDE_EFFORT_VERSION);
}

export function piVersionSupported(version: string): boolean {
	return versionAtLeast(version, MIN_PI_VERSION);
}

/** Refuse an enforced assignment if this exact boot cannot uphold it. */
export function assignmentEffortRejection(
	assignment: RunnerAssignment,
	capabilities: EffortCapabilities | undefined,
	harness: HarnessKind
): string | null {
	if (!assignment.effort) return null;
	if (!capabilities || capabilities.version !== 1 || !('models' in capabilities))
		return 'effort assignment requires a compatible V1 daemon capability report';
	if (capabilities.harness !== harness)
		return `effort assignment requires ${capabilities.harness}, but this daemon runs ${harness}`;
	if (capabilities.catalog_digest !== assignment.effort.capability_digest)
		return 'effort capability catalog changed after assignment delivery';
	const admission = admitEffort(
		supportedEfforts(capabilities, assignment.run.model),
		assignment.effort.value,
		assignment.effort.verification === 'asserted'
	);
	if (!admission.ok)
		return admission.reason.startsWith('unsupported_effort:')
			? `${assignment.run.model ?? 'the assigned model'} does not support effort ${assignment.effort.value}`
			: `${assignment.run.model ?? 'the assigned model'}: ${admission.reason}`;
	return null;
}

function digest(models: EffortCapabilitiesV1['models']): string {
	return createHash('sha256').update(JSON.stringify(models)).digest('hex');
}

function failure(
	harness: 'claude_code' | 'codex' | 'pi',
	daemonVersion: string,
	reason: string
): EffortCapabilitiesV1 {
	return {
		version: 1,
		daemon_version: daemonVersion.slice(0, 100),
		harness,
		harness_version: 'unknown',
		catalog_digest: digest([]),
		models: [],
		discovery_error: reason.slice(0, 200)
	};
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: DEADLINE_MS, maxBuffer: MAX_STDOUT }, (error, stdout) =>
			error ? reject(error) : resolve(stdout)
		);
	});
}

const CLAUDE_MODELS: Record<string, string[]> = {
	'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
	'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
	'claude-sonnet-4-6': ['low', 'medium', 'high', 'max']
};

async function discoverClaude(daemonVersion: string): Promise<EffortCapabilitiesV1> {
	try {
		const [version, help] = await Promise.all([
			run('claude', ['--version']),
			run('claude', ['--help'])
		]);
		if (!help.includes('--effort'))
			return failure('claude_code', daemonVersion, 'installed Claude CLI has no --effort option');
		if (!claudeEffortVersionSupported(version))
			return failure(
				'claude_code',
				daemonVersion,
				`installed Claude CLI ${version.trim()} predates verified --effort support 2.1.258`
			);
		const models = Object.entries(CLAUDE_MODELS).map(([model, efforts]) => ({ model, efforts }));
		return {
			version: 1,
			daemon_version: daemonVersion,
			harness: 'claude_code',
			harness_version: version.trim().slice(0, 100),
			catalog_revision: 'claude-effort-v1',
			catalog_digest: digest(models),
			models,
			accepts_asserted_effort: true
		};
	} catch (error) {
		return failure(
			'claude_code',
			daemonVersion,
			error instanceof Error ? error.message : String(error)
		);
	}
}

async function discoverCodex(daemonVersion: string): Promise<EffortCapabilitiesV1> {
	let harnessVersion: string;
	try {
		harnessVersion = (await run('codex', ['--version'])).trim().slice(0, 100);
	} catch (error) {
		return failure('codex', daemonVersion, error instanceof Error ? error.message : String(error));
	}
	return new Promise((resolve) => {
		const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
		let buffer = '';
		let bytes = 0;
		let settled = false;
		let requestId = 2;
		const models: EffortCapabilitiesV1['models'] = [];
		const finish = (report: EffortCapabilitiesV1) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve(report);
		};
		const fail = (reason: string) => finish(failure('codex', daemonVersion, reason));
		const sendList = (cursor?: string) => {
			requestId += 1;
			child.stdin.write(
				`${JSON.stringify({ id: requestId, method: 'model/list', params: { includeHidden: true, ...(cursor ? { cursor } : {}) } })}\n`
			);
		};
		const timer = setTimeout(() => fail('Codex model discovery timed out'), DEADLINE_MS);
		child.on('error', (error) => fail(error.message));
		// The handshake writes to the app-server's stdin. A Codex that exits
		// before reading it (an older CLI without `app-server`, a crash at
		// startup, or simply losing the race to our first write on a loaded
		// machine) turns that write into EPIPE, and an unhandled stream error
		// takes the whole daemon down with it. Both are discovery failures.
		child.stdin.on('error', (error) => fail(`Codex app-server stdin: ${error.message}`));
		child.on('close', (code, signal) =>
			fail(`Codex app-server exited (${signal ?? `code ${code}`}) before listing models`)
		);
		child.stdout.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_STDOUT) return fail('Codex model discovery exceeded 1 MiB');
			buffer += chunk.toString('utf8');
			for (;;) {
				const newline = buffer.indexOf('\n');
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				let message: Record<string, any>;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === 1 && message.result) {
					child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
					sendList();
				} else if (typeof message.id === 'number' && message.id >= 3 && message.result) {
					for (const entry of message.result.data ?? []) {
						const efforts: string[] = (entry.supportedReasoningEfforts ?? [])
							.map((item: any) => item.reasoningEffort)
							.filter((item: unknown): item is string => typeof item === 'string') as string[];
						if (typeof entry.model === 'string' && efforts.length)
							models.push({ model: entry.model, efforts: [...new Set(efforts)] });
					}
					if (message.result.nextCursor) sendList(message.result.nextCursor);
					else
						finish({
							version: 1,
							daemon_version: daemonVersion,
							harness: 'codex',
							harness_version: harnessVersion,
							catalog_digest: digest(models),
							models,
							accepts_asserted_effort: true
						});
				}
			}
		});
		child.stdin.write(
			`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tines', version: daemonVersion } } })}\n`
		);
	});
}

/**
 * Pi's catalog is whatever this machine has configured, so it is read from
 * the running `pi` over its RPC mode: the model list, then each model's
 * thinking levels. Records are JSONL split on LF only (Pi's docs/rpc.md), and
 * the commands go **one at a time**, each waiting for its own response —
 * `get_available_thinking_levels` answers for whichever model is current, so
 * a burst would race the `set_model` before it.
 *
 * `set_model` over RPC does not persist a default, and `--no-session` keeps
 * the probe out of the session directory. A model with no recognized level is
 * listed with `efforts: []`: it is a model this runner can launch, just not
 * one effort can be routed to.
 */
export async function discoverPi(
	daemonVersion: string,
	deadlineMs = PI_DEADLINE_MS
): Promise<EffortCapabilitiesV1> {
	let harnessVersion: string;
	try {
		harnessVersion = (await run('pi', ['--version'])).trim().slice(0, 100);
	} catch (error) {
		return failure('pi', daemonVersion, error instanceof Error ? error.message : String(error));
	}
	if (!piVersionSupported(harnessVersion))
		return failure(
			'pi',
			daemonVersion,
			`installed pi ${harnessVersion || 'unknown'} predates the supported ${MIN_PI_VERSION.join('.')}`
		);
	return new Promise((resolve) => {
		const child = spawn('pi', ['--mode', 'rpc', '--no-session'], {
			stdio: ['pipe', 'pipe', 'ignore']
		});
		let buffer = '';
		let bytes = 0;
		let settled = false;
		let requestId = 0;
		/** The one command in flight; its response is matched by id. */
		let awaiting: { id: string; deliver: (response: Record<string, any>) => void } | null = null;
		const finish = (report: EffortCapabilitiesV1) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve(report);
		};
		const fail = (reason: string) => finish(failure('pi', daemonVersion, reason));
		const request = (command: Record<string, unknown>) =>
			new Promise<Record<string, any>>((deliver) => {
				const id = `tines-${++requestId}`;
				awaiting = { id, deliver };
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			});
		const timer = setTimeout(() => fail('pi model discovery timed out'), deadlineMs);
		child.on('error', (error) => fail(error.message));
		// As for Codex: a `pi` that exits before reading a command turns the
		// write into EPIPE, and an unhandled stream error would take the daemon
		// down with it.
		child.stdin.on('error', (error) => fail(`pi rpc stdin: ${error.message}`));
		child.on('close', (code, signal) =>
			fail(`pi rpc exited (${signal ?? `code ${code}`}) before listing models`)
		);
		child.stdout.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_STDOUT) return fail('pi model discovery exceeded 1 MiB');
			buffer += chunk.toString('utf8');
			for (;;) {
				const newline = buffer.indexOf('\n');
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				let record: Record<string, any>;
				try {
					record = JSON.parse(line);
				} catch {
					continue;
				}
				// Session events share the pipe; only the awaited response counts.
				if (record?.type !== 'response' || !awaiting || record.id !== awaiting.id) continue;
				const { deliver } = awaiting;
				awaiting = null;
				deliver(record);
			}
		});
		void (async () => {
			const listed = await request({ type: 'get_available_models' });
			if (!listed.success)
				return fail(`pi get_available_models failed: ${String(listed.error ?? 'no reason given')}`);
			const models: EffortCapabilitiesV1['models'] = [];
			const names = new Set<string>();
			for (const entry of Array.isArray(listed.data?.models) ? listed.data.models : []) {
				if (settled || models.length >= EFFORT_CAPABILITIES_MAX_MODELS) break;
				if (typeof entry?.provider !== 'string' || typeof entry?.id !== 'string') continue;
				const model = `${entry.provider}/${entry.id}`;
				if (model.length > 200 || names.has(model)) continue;
				const selected = await request({
					type: 'set_model',
					provider: entry.provider,
					modelId: entry.id
				});
				// Not selectable here (no credentials for it): not a model to route to.
				if (!selected.success) continue;
				const thinking = await request({ type: 'get_available_thinking_levels' });
				const levels: unknown[] =
					thinking.success && Array.isArray(thinking.data?.levels) ? thinking.data.levels : [];
				names.add(model);
				models.push({ model, efforts: [...new Set(levels.filter(isRecognizedEffort))] });
			}
			// Not `accepts_asserted_effort`: this catalog is the machine's whole
			// model list, so a model missing from it is one Pi cannot run.
			finish({
				version: 1,
				daemon_version: daemonVersion,
				harness: 'pi',
				harness_version: harnessVersion,
				catalog_digest: digest(models),
				models
			});
		})();
	});
}

export async function discoverEffortCapabilities(harness: HarnessKind, daemonVersion: string) {
	if (harness === 'custom') return undefined;
	if (harness === 'pi') return discoverPi(daemonVersion);
	return harness === 'codex' ? discoverCodex(daemonVersion) : discoverClaude(daemonVersion);
}

/** Coalesces discovery, refreshes idle daemons, and supports a mandatory launch-time reprobe. */
export class EffortCapabilityRefresher {
	private value: EffortCapabilities | undefined;
	private refreshedAt = 0;
	private pending: Promise<EffortCapabilities | undefined> | null = null;

	constructor(
		private readonly harness: HarnessKind,
		private readonly daemonVersion: string,
		private readonly discover = discoverEffortCapabilities,
		private readonly now = Date.now
	) {}

	async get(force = false): Promise<EffortCapabilities | undefined> {
		if (!force && this.refreshedAt && this.now() - this.refreshedAt < EFFORT_CAPABILITIES_TTL_MS)
			return this.value;
		if (this.pending) return this.pending;
		this.pending = this.discover(this.harness, this.daemonVersion).then((value) => {
			this.value = value;
			this.refreshedAt = this.now();
			return value;
		});
		try {
			return await this.pending;
		} finally {
			this.pending = null;
		}
	}
}
