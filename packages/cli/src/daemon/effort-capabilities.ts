import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
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

export function claudeEffortVersionSupported(version: string): boolean {
	const parsed = version
		.match(/(\d+)\.(\d+)\.(\d+)/)
		?.slice(1)
		.map(Number);
	if (!parsed) return false;
	for (let i = 0; i < MIN_CLAUDE_EFFORT_VERSION.length; i++) {
		if (parsed[i]! > MIN_CLAUDE_EFFORT_VERSION[i]!) return true;
		if (parsed[i]! < MIN_CLAUDE_EFFORT_VERSION[i]!) return false;
	}
	return true;
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
	const allowed = supportedEfforts(capabilities, assignment.run.model);
	if (!allowed?.includes(assignment.effort.value))
		return `${assignment.run.model ?? 'the assigned model'} does not support effort ${assignment.effort.value}`;
	return null;
}

function digest(models: EffortCapabilitiesV1['models']): string {
	return createHash('sha256').update(JSON.stringify(models)).digest('hex');
}

function failure(
	harness: 'claude_code' | 'codex',
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
			models
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
							models
						});
				}
			}
		});
		child.stdin.write(
			`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'tines', version: daemonVersion } } })}\n`
		);
	});
}

export async function discoverEffortCapabilities(harness: HarnessKind, daemonVersion: string) {
	if (harness === 'custom') return undefined;
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
