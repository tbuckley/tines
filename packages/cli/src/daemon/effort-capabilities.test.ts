import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { EffortCapabilitiesV1, RunnerAssignment } from '@tines/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assignmentEffortRejection,
	claudeEffortVersionSupported,
	discoverEffortCapabilities,
	discoverPi,
	EFFORT_CAPABILITIES_TTL_MS,
	EffortCapabilityRefresher,
	piVersionSupported
} from './effort-capabilities.js';
import { installFakePi, type FakePiConfig } from '../test-fake-pi.js';

const capabilities: EffortCapabilitiesV1 = {
	version: 1,
	daemon_version: '0.0.194',
	harness: 'codex',
	harness_version: '0.153.4',
	catalog_digest: 'catalog-a',
	models: [{ model: 'gpt-5.6', efforts: ['low', 'high'] }],
	accepts_asserted_effort: true
};

function assignment(
	value = 'low',
	digest = 'catalog-a',
	verification?: 'asserted'
): RunnerAssignment {
	return {
		run: { id: 'arun_1', model: 'gpt-5.6' },
		effort: {
			version: 1,
			value,
			capability_digest: digest,
			source: { kind: 'runner_tier', runner_id: 'rnr_1', tier: 'balanced' },
			...(verification ? { verification } : {})
		}
	} as unknown as RunnerAssignment;
}

describe('assignmentEffortRejection', () => {
	it('accepts only the delivered catalog, exact model, value and harness', () => {
		expect(assignmentEffortRejection(assignment(), capabilities, 'codex')).toBeNull();
		expect(assignmentEffortRejection(assignment('ultra'), capabilities, 'codex')).toContain(
			'does not support'
		);
		expect(
			assignmentEffortRejection(assignment('low', 'catalog-b'), capabilities, 'codex')
		).toContain('catalog changed');
		expect(assignmentEffortRejection(assignment(), capabilities, 'claude_code')).toContain(
			'this daemon runs claude_code'
		);
		expect(assignmentEffortRejection(assignment(), undefined, 'codex')).toContain('requires');
		expect(
			assignmentEffortRejection(
				{
					...assignment('ultra'),
					effort: { ...assignment('ultra').effort!, verification: 'asserted' }
				},
				{ ...capabilities, models: [] },
				'codex'
			)
		).toBeNull();
	});

	it('preserves old assignments without an effort block', () => {
		const old = { run: { id: 'arun_old' } } as unknown as RunnerAssignment;
		expect(assignmentEffortRejection(old, undefined, 'custom')).toBeNull();
	});

	it('rejects asserted effort when the fresh probe lists the model without it', () => {
		const asserted = assignment('ultra', 'catalog-a', 'asserted');
		expect(assignmentEffortRejection(asserted, capabilities, 'codex')).toContain(
			'does not support'
		);
	});
});

describe('capability refresh', () => {
	it('enforces the researched Claude minimum version', () => {
		expect(claudeEffortVersionSupported('2.1.257 (Claude Code)')).toBe(false);
		expect(claudeEffortVersionSupported('2.1.258 (Claude Code)')).toBe(true);
		expect(claudeEffortVersionSupported('2.2.0')).toBe(true);
		expect(claudeEffortVersionSupported('unknown')).toBe(false);
	});

	it('enforces the probed Pi minimum version', () => {
		expect(piVersionSupported('0.99.1')).toBe(false);
		expect(piVersionSupported('0.98.12')).toBe(false);
		expect(piVersionSupported('0.99.2')).toBe(true);
		expect(piVersionSupported('1.0.1')).toBe(true);
		expect(piVersionSupported('')).toBe(false);
	});

	it('caches within the TTL, coalesces refreshes, and supports a launch reprobe', async () => {
		let now = 1;
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const discover = async () => {
			calls++;
			if (calls === 1) await gate;
			return capabilities;
		};
		const refresher = new EffortCapabilityRefresher('codex', 'test', discover, () => now);
		const a = refresher.get();
		const b = refresher.get();
		release();
		await Promise.all([a, b]);
		expect(calls).toBe(1);
		await refresher.get();
		expect(calls).toBe(1);
		await refresher.get(true);
		expect(calls).toBe(2);
		now += EFFORT_CAPABILITIES_TTL_MS + 1;
		await refresher.get();
		expect(calls).toBe(3);
	});
});

describe('Codex discovery against a broken app-server', () => {
	let dir: string | null = null;
	const originalPath = process.env.PATH;

	/** A `codex` on PATH whose `--version` answers but whose `app-server` runs `body`. */
	function fakeCodex(body: string): void {
		dir = mkdtempSync(join(tmpdir(), 'tines-codex-probe-'));
		const bin = join(dir, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'codex'),
			`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.153.4"; exit 0; fi\n${body}\n`,
			{ mode: 0o755 }
		);
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
	}

	afterEach(() => {
		process.env.PATH = originalPath;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it('survives an app-server that closes stdin before the handshake is written', async () => {
		// The fake closes its stdin, then answers the initialize request, then
		// lingers: the daemon's follow-up writes (initialized, model/list) land
		// on a closed pipe and EPIPE deterministically. That is the shape of a
		// Codex that stops reading before the handshake completes — on a loaded
		// machine the daemon used to lose that race by crashing on the
		// unhandled stream error, taking every in-flight run with it.
		fakeCodex('exec 0<&-\necho \'{"id":1,"result":{}}\'\nsleep 3');
		const started = Date.now();
		const report = await discoverEffortCapabilities('codex', 'test');
		expect(Date.now() - started).toBeLessThan(2500);
		expect(report).toMatchObject({ harness: 'codex', models: [] });
		expect(report && 'discovery_error' in report ? report.discovery_error : '').toContain(
			'Codex app-server stdin: write EPIPE'
		);
	});

	it('reports an app-server that exits without answering, without waiting out the deadline', async () => {
		fakeCodex('exit 3');
		const started = Date.now();
		const report = await discoverEffortCapabilities('codex', 'test');
		expect(Date.now() - started).toBeLessThan(4000);
		// Which failure lands first is a race the fake cannot fix: if the
		// process is gone before our initialize write reaches the pipe, the
		// write's EPIPE arrives before the close event does. Both are the same
		// fast, non-fatal discovery failure — that, not the wording, is the
		// contract. (Deploy hit the EPIPE ordering on its first run.)
		expect(report && 'discovery_error' in report ? report.discovery_error : '').toMatch(
			/^Codex app-server (exited \(code 3\) before listing models|stdin: write EPIPE)$/
		);
	});
});

describe('Pi discovery over RPC', () => {
	let dir: string | null = null;
	const originalPath = process.env.PATH;

	function fakePi(config: FakePiConfig): string {
		dir = mkdtempSync(join(tmpdir(), 'tines-pi-probe-'));
		const bin = installFakePi(dir, config);
		process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
		return bin;
	}

	afterEach(() => {
		process.env.PATH = originalPath;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it('lists each model with its recognized thinking levels, one command at a time', async () => {
		const bin = fakePi({
			rpc: 'serve',
			models: [
				{ provider: 'mock', id: 'think', levels: ['off', 'minimal', 'low', 'medium', 'high'] },
				{ provider: 'mock', id: 'plain', levels: ['off'] },
				{ provider: 'hosted', id: 'no-key', levels: ['low'], selectable: false },
				{ provider: 'mock', id: 'think', levels: ['max'] },
				{ provider: 'mock', id: 'deep', levels: ['high', 'xhigh', 'max'] }
			]
		});
		const report = await discoverEffortCapabilities('pi', 'test');
		// `off` and `minimal` are Pi levels but not efforts Tines routes; a
		// model with none is still listed, a model Pi cannot select is not.
		expect(report).toMatchObject({
			version: 1,
			harness: 'pi',
			harness_version: '0.99.2',
			models: [
				{ model: 'mock/think', efforts: ['low', 'medium', 'high'] },
				{ model: 'mock/plain', efforts: [] },
				{ model: 'mock/deep', efforts: ['high', 'xhigh', 'max'] }
			]
		});
		expect(report).not.toHaveProperty('discovery_error');
		// The catalog is the machine's whole model list, so nothing is asserted beyond it.
		expect(report).not.toHaveProperty('accepts_asserted_effort');
		// Every level above belongs to the model selected just before it was
		// asked for, and the fake saw no command arrive while one was open.
		expect(existsSync(join(bin, 'burst'))).toBe(false);
	});

	it('reports an empty catalog, not an error, when Pi has no models', async () => {
		fakePi({ rpc: 'serve', models: [] });
		const report = await discoverEffortCapabilities('pi', 'test');
		expect(report).toMatchObject({ harness: 'pi', models: [] });
		expect(report).not.toHaveProperty('discovery_error');
	});

	it('refuses a pi below the version floor without starting RPC', async () => {
		const bin = fakePi({ version: '0.98.4', rpc: 'serve', models: [] });
		const report = await discoverEffortCapabilities('pi', 'test');
		expect(report).toMatchObject({
			harness: 'pi',
			models: [],
			discovery_error: 'installed pi 0.98.4 predates the supported 0.99.2'
		});
		expect(existsSync(join(bin, 'burst'))).toBe(false);
	});

	it('reports a pi that exits without answering, without waiting out the deadline', async () => {
		fakePi({ rpc: 'exit' });
		const started = Date.now();
		const report = await discoverEffortCapabilities('pi', 'test');
		expect(Date.now() - started).toBeLessThan(5000);
		// As for Codex, the write's EPIPE can beat the close event.
		expect(report && 'discovery_error' in report ? report.discovery_error : '').toMatch(
			/^pi rpc (exited \(code 3\) before listing models|stdin: write EPIPE)$/
		);
	});

	it('gives up at its deadline on a pi that never answers', async () => {
		fakePi({ rpc: 'hang' });
		const report = await discoverPi('test', 400);
		expect(report).toMatchObject({
			harness: 'pi',
			models: [],
			discovery_error: 'pi model discovery timed out'
		});
	});
});
